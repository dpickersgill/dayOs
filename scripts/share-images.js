'use strict';

// Draws each page's share image (1200 x 630, the picture a link preview shows) into public/site/img/share/<file>.png,
// from the words in src/lib/share.js. Run it after adding or changing a page there, then look at every image:
//   node scripts/share-images.js            all of them
//   node scripts/share-images.js ski-patrol pricing   just these pages ("" or home for Home)
// Needs Playwright (Chromium). The brand fonts and the Verdynt/OS lockup are embedded from public/, so nothing is fetched.
// When ImageMagick's convert is on the computer the PNGs are reduced to a small palette afterwards (a few tens of KB each).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SHARE, fileFor } = require('../src/lib/share');

let pw; try { pw = require('playwright'); } catch (_) { pw = require('/opt/npm-tools/node_modules/playwright'); }

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'site', 'img', 'share');
const b64 = (f, type) => `data:${type};base64,${fs.readFileSync(path.join(ROOT, 'public', f)).toString('base64')}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The ridge drawn at the right: three lines of a mountain, like the mark, faint on the slate. A drawing, not a photo.
const RIDGE = `<svg class="ridge" width="560" height="630" viewBox="0 0 560 630" aria-hidden="true">
  <path d="M0 560 L170 330 L240 410 L360 220 L470 360 L560 280" fill="none" stroke="#1E4553" stroke-width="3"/>
  <path d="M0 600 L150 420 L230 500 L370 300 L480 440 L560 380" fill="none" stroke="#1E4553" stroke-width="3" opacity=".7"/>
  <path d="M60 630 L200 480 L280 560 L390 400 L500 520 L560 470" fill="none" stroke="#1E4553" stroke-width="3" opacity=".45"/>
  <path d="M330 262 L360 220 L392 268" fill="none" stroke="#D8B672" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function html(t) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@font-face{font-family:'Atkinson Hyperlegible';font-weight:400;src:url('${b64('fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'font/woff2')}') format('woff2')}
@font-face{font-family:'Atkinson Hyperlegible';font-weight:700;src:url('${b64('fonts/atkinson-hyperlegible-latin-700-normal.woff2', 'font/woff2')}') format('woff2')}
@font-face{font-family:'Barlow Condensed';font-weight:700;src:url('${b64('fonts/barlow-condensed-latin-700-normal.woff2', 'font/woff2')}') format('woff2')}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;overflow:hidden}
body{background:#12303A;color:#EEF4F7;font-family:'Atkinson Hyperlegible',sans-serif;position:relative}
.ridge{position:absolute;right:0;top:0}
.bar{position:absolute;left:0;right:0;bottom:0;height:14px;background:#D8B672}
.in{position:absolute;left:80px;top:64px;bottom:62px;width:820px;display:flex;flex-direction:column}
.lockup{height:52px;width:auto;align-self:flex-start}
.mid{margin-top:auto;margin-bottom:auto;padding-top:18px}
.k{display:inline-block;background:#D8B672;color:#12303A;font-weight:700;font-size:24px;letter-spacing:.06em;text-transform:uppercase;padding:5px 14px;border-radius:4px;margin-bottom:22px}
h1{font-family:'Barlow Condensed',sans-serif;font-weight:700;text-transform:uppercase;line-height:.94;letter-spacing:.005em;font-size:112px;color:#FFFFFF}
.s{margin-top:24px;font-size:34px;line-height:1.3;color:#C7DAE3;max-width:800px}
.u{position:absolute;right:64px;bottom:40px;font-size:22px;font-weight:700;color:#D8B672;letter-spacing:.02em}
</style></head><body>
${RIDGE}
<div class="in">
  <img class="lockup" src="${b64('brand/verdynt-lockup-dark.png', 'image/png')}" alt="Verdynt/OS">
  <div class="mid"><span class="k">${esc(t.kicker)}</span><h1 id="h">${esc(t.headline)}</h1><p class="s">${esc(t.sub)}</p></div>
</div>
<p class="u">runmyresort.com</p>
<div class="bar"></div>
</body></html>`;
}

async function draw(page, slug) {
  const t = SHARE[slug];
  await page.setContent(html(t), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  // The headline as large as fits: two lines at full size, or three smaller ones, never crowding the lockup.
  await page.evaluate(() => {
    const h = document.getElementById('h'); const box = document.querySelector('.in');
    let size = 112;
    const tooBig = () => h.getBoundingClientRect().height > 250 || h.scrollWidth > h.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1;
    while (size > 56 && tooBig()) { size -= 4; h.style.fontSize = `${size}px`; }
  });
  const out = path.join(OUT_DIR, `${fileFor(slug)}.png`);
  await page.screenshot({ path: out, type: 'png' });
  try { execFileSync('convert', [out, '-strip', '-colors', '128', `PNG8:${out}`], { stdio: 'ignore' }); } catch (_) { /* no ImageMagick: keep the full PNG */ }
  return out;
}

(async () => {
  const want = process.argv.slice(2).map((s) => (s === 'home' ? '' : s));
  const slugs = want.length ? want : Object.keys(SHARE);
  for (const s of slugs) if (!(s in SHARE)) throw new Error(`No share words for "${s}" in src/lib/share.js`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  for (const s of slugs) {
    const out = await draw(page, s);
    console.log(`Wrote ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  }
  await browser.close();
})().catch((err) => { console.error(err); process.exit(1); });
