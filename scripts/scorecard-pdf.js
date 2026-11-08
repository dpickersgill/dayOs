'use strict';

// Builds the printable Good Day scorecard, public/site/good-day-scorecard.pdf, from the same questions as the web page
// (src/lib/scorecard.js). Run it after changing a question:  node scripts/scorecard-pdf.js
// Needs Playwright (Chromium). The brand fonts are embedded from public/fonts, so the PDF looks the same everywhere.
const fs = require('node:fs');
const path = require('node:path');
const SC = require('../src/lib/scorecard');

let pw; try { pw = require('playwright'); } catch (_) { pw = require('/opt/npm-tools/node_modules/playwright'); }

const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'public', 'site', 'good-day-scorecard.pdf');
const font = (f) => `data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'public', 'fonts', f)).toString('base64')}`;

function html() {
  const bandRange = (b, i) => `${b.min} to ${i === 0 ? SC.MAX : SC.BANDS[i - 1].min - 1}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The Good Day scorecard</title><style>
@font-face{font-family:'Atkinson Hyperlegible';font-weight:400;src:url('${font('atkinson-hyperlegible-latin-400-normal.woff2')}') format('woff2')}
@font-face{font-family:'Atkinson Hyperlegible';font-weight:700;src:url('${font('atkinson-hyperlegible-latin-700-normal.woff2')}') format('woff2')}
@font-face{font-family:'Barlow Condensed';font-weight:700;src:url('${font('barlow-condensed-latin-700-normal.woff2')}') format('woff2')}
:root{--slate:#12303A;--spruce:#2C7A57;--gold:#D8B672;--gold-wash:#F7F0E1;--line:#C7D9E3;--muted:#4B6570}
@page{size:Letter;margin:14mm 14mm 16mm}
*{box-sizing:border-box}
body{margin:0;font-family:'Atkinson Hyperlegible',Helvetica,Arial,sans-serif;color:var(--slate);font-size:10.5pt;line-height:1.4}
h1,h2,.disp{font-family:'Barlow Condensed','Arial Narrow',sans-serif;font-weight:700;text-transform:uppercase;margin:0}
.mast{background:var(--slate);color:#eef4f7;border-radius:8px;padding:14px 18px;border-bottom:5px solid var(--gold)}
.mast .k{color:var(--gold);font-weight:700;font-size:9.5pt;letter-spacing:.12em;text-transform:uppercase;margin:0 0 4px}
.mast h1{font-size:30pt;line-height:.95}
.mast p.s{margin:6px 0 0;color:#C7DAE3}
.meta{display:flex;gap:16px;margin:10px 0 4px;font-size:10pt}
.meta span{flex:1;border-bottom:1px solid var(--slate);padding-bottom:2px}
.how{margin:6px 0 2px;color:var(--muted);font-size:9.5pt}
.parea{break-inside:avoid;margin-top:10px}
.parea h2{font-size:14pt;color:var(--spruce);border-bottom:2px solid var(--gold);padding-bottom:2px}
.pqs{list-style:none;margin:0;padding:0}
.pq{break-inside:avoid;padding:6px 0;border-bottom:1px solid var(--line)}
.pq p{margin:0 0 4px}
.pa{list-style:none;margin:0;padding:0;display:flex;gap:18px;font-size:9.5pt}
.pa i{font-style:normal;color:var(--muted)}
.box{display:inline-block;width:11px;height:11px;border:1.5px solid var(--slate);border-radius:2px;margin-right:6px;vertical-align:-1px}
.total{break-inside:avoid;margin-top:12px;padding:10px 14px;border-radius:8px;background:var(--gold-wash);border-left:5px solid var(--gold)}
.total .disp{font-size:15pt}
.total ul{margin:6px 0 0;padding-left:16px}
.foot{margin-top:10px;font-size:9pt;color:var(--muted)}
</style></head><body>
<div class="mast"><p class="k">The Good Day &middot; scorecard</p><h1>How good is your guest's day?</h1>
<p class="s">${SC.QUESTIONS.length} questions for ski area owners, GMs and patrol directors, about five minutes. Answer for an ordinary busy day, not your best one. "Not sure" counts as no.</p></div>
<div class="meta"><span>Mountain:</span><span>Filled in by:</span><span>Date:</span></div>
<p class="how">Tick one box per question. Yes, every day scores 2; partly, or some days scores 1; no, or not sure scores 0.</p>
${SC.questionsHtml({ print: true })}
<div class="total"><p class="disp">Your score: ______ of ${SC.MAX}</p>
<ul>${SC.BANDS.map((b, i) => `<li><b>${bandRange(b, i)}:</b> ${b.title}</li>`).join('')}</ul></div>
<p class="foot">Start with your lowest area. Score it online for a plain next step on each gap: www.runmyresort.com/good-day/scorecard. The Good Day is a newsletter from Verdynt/OS for ski area owners, GMs and patrol directors.</p>
</body></html>`;
}

(async () => {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html(), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: OUT, format: 'Letter', printBackground: true, preferCSSPageSize: true });
  await browser.close();
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
})().catch((err) => { console.error(err); process.exit(1); });
