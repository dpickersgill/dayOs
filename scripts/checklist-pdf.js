'use strict';

// Builds the printable PDF of each guide's checklist, public/site/<slug>.pdf, from the guide page itself
// (src/site/<template>.html), so the PDF never says something the page does not. One command builds every guide's PDF,
// these and the ones marked <!--PDF--> (scripts/guide-pdfs.js):
//   node scripts/guide-pdfs.js                                 every guide
//   node scripts/guide-pdfs.js chairlift-inspection-checklist  just these
// (node scripts/checklist-pdf.js [slug ...] still builds only the guides listed below.)
// Needs Playwright (Chromium). The brand fonts and the lockup are embedded from public/, so the PDF looks the same everywhere.
//
// To add a guide: one line in GUIDES, then a "Download the printable PDF" link on its page (href="/site/<slug>.pdf").
//   slug      the page's address, and the PDF's name
//   template  its file in src/site, without .html
//   sections  the page's sections to print, each named by its H2's id ("#checklist") or the start of its H2 text
//             ("Before you start"). A section runs from its H2 to the next H2. The page's H1, its first line and its
//             sources line are always printed; links become plain text and anything marked no-print is left out.
const fs = require('node:fs');
const path = require('node:path');

let pw; try { pw = require('playwright'); } catch (_) { pw = require('/opt/npm-tools/node_modules/playwright'); }

const GUIDES = [
  { slug: 'chairlift-inspection-checklist', template: 'guide-chairlift', sections: ['Before you start', '#checklist', 'What a good daily record'] },
  { slug: 'terrain-park-inspection-checklist', template: 'guide-terrainpark', sections: ['#checklist', 'What the daily record'] },
  { slug: 'ski-area-incident-report-guide', template: 'guide-incident', sections: ['#checklist', 'What every report should record'] },
  { slug: 'how-to-choose-ski-area-software', template: 'guide-choosing', sections: ['What to compare', '#checklist'] },
];

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'site');
const b64 = (f, type) => `data:${type};base64,${fs.readFileSync(path.join(ROOT, 'public', f)).toString('base64')}`;
const SITE = 'www.runmyresort.com';

/** The parts of a guide page to print, read in the browser: { title, lead, sections: [html], source }. */
async function readGuide(page, g) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'site', `${g.template}.html`), 'utf8')
    .replace('<!--HEAD-->', '').replace(/<!--[A-Z]+[^>]*-->/g, '').replace(/\{\{[A-Z_]+\}\}/g, '');
  await page.setContent(src, { waitUntil: 'domcontentloaded' });
  return page.evaluate((want) => {
    const main = document.querySelector('main');
    main.querySelectorAll('.no-print, script, button, .guide-actions, .guide-meta, .crumbs').forEach((n) => n.remove());
    main.querySelectorAll('a').forEach((a) => a.replaceWith(document.createTextNode(a.textContent)));
    const h1 = main.querySelector('h1');
    const title = h1.textContent.trim().replace(/\.$/, '');
    const lead = (h1.parentElement.querySelector('h1 ~ p') || { textContent: '' }).textContent.trim();
    const body = main.querySelector('.legal');
    const h2s = [...body.querySelectorAll(':scope > h2')];
    const sections = [];
    for (const w of want) {
      const h = h2s.find((x) => (w.startsWith('#') ? x.id === w.slice(1) : x.textContent.trim().toLowerCase().startsWith(w.toLowerCase())));
      if (!h) throw new Error(`No section "${w}" on the page`);
      const parts = [h.outerHTML.replace(/ id="[^"]*"/, '')];
      for (let n = h.nextElementSibling; n && n.tagName !== 'H2'; n = n.nextElementSibling) if (!n.classList.contains('src')) parts.push(n.outerHTML);
      sections.push(parts.join('\n'));
    }
    const s = body.querySelector('.src');
    return { title, lead, sections, source: s ? s.textContent.trim() : '' };
  }, g.sections);
}

function html(g, d) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${d.title}</title><style>
@font-face{font-family:'Atkinson Hyperlegible';font-weight:400;src:url('${b64('fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'font/woff2')}') format('woff2')}
@font-face{font-family:'Atkinson Hyperlegible';font-weight:700;src:url('${b64('fonts/atkinson-hyperlegible-latin-700-normal.woff2', 'font/woff2')}') format('woff2')}
@font-face{font-family:'Barlow Condensed';font-weight:700;src:url('${b64('fonts/barlow-condensed-latin-700-normal.woff2', 'font/woff2')}') format('woff2')}
:root{--slate:#12303A;--spruce:#2C7A57;--gold:#D8B672;--gold-wash:#F7F0E1;--line:#C7D9E3;--muted:#4B6570}
@page{size:Letter;margin:14mm 14mm 16mm}
*{box-sizing:border-box}
body{margin:0;font-family:'Atkinson Hyperlegible',Helvetica,Arial,sans-serif;color:var(--slate);font-size:10.5pt;line-height:1.42}
h1,h2,h3{font-family:'Barlow Condensed','Arial Narrow',sans-serif;font-weight:700;margin:0}
.mast{background:var(--slate);color:#eef4f7;border-radius:8px;padding:14px 18px;border-bottom:5px solid var(--gold);display:flex;gap:16px;align-items:flex-start}
.mast div{flex:1}
.mast .k{color:var(--gold);font-weight:700;font-size:9pt;letter-spacing:.12em;text-transform:uppercase;margin:0 0 4px}
.mast h1{font-size:27pt;line-height:.98;text-transform:uppercase}
.mast p.s{margin:6px 0 0;color:#C7DAE3;font-size:10pt}
.mast img{height:22px;width:auto;margin-top:2px}
.meta{display:flex;gap:16px;margin:10px 0 2px;font-size:10pt}
.meta span{flex:1;border-bottom:1px solid var(--slate);padding-bottom:2px}
h2{font-size:15pt;color:var(--spruce);border-bottom:2px solid var(--gold);padding-bottom:2px;margin:14px 0 6px;text-transform:uppercase;break-after:avoid}
h3{font-size:12pt;margin:10px 0 2px;text-transform:uppercase;letter-spacing:.02em;break-after:avoid}
p{margin:4px 0}
ul,ol{margin:4px 0;padding-left:18px}
li{margin:2px 0}
ul.checklist{list-style:none;padding:0;margin:2px 0 4px}
ul.checklist li{break-inside:avoid;padding:4px 0 4px 22px;border-bottom:1px solid var(--line);position:relative;margin:0}
ul.checklist li::before{content:'';position:absolute;left:0;top:6px;width:11px;height:11px;border:1.5px solid var(--slate);border-radius:2px}
.callout{background:var(--gold-wash);border-left:4px solid var(--gold);padding:6px 10px;border-radius:4px;margin:6px 0;break-inside:avoid}
.sign{display:flex;gap:14px;margin:12px 0 4px;break-inside:avoid}
.sign span{flex:1;border-top:1.2px solid var(--slate);padding-top:3px;font-size:9pt;color:var(--muted);margin-top:22px}
.foot{margin-top:12px;padding-top:6px;border-top:1px solid var(--line);font-size:8.5pt;color:var(--muted)}
.foot p{margin:2px 0}
</style></head><body>
<div class="mast"><div><p class="k">Verdynt/OS &middot; free printable</p><h1>${d.title}</h1><p class="s">${d.lead}</p></div><img src="${b64('brand/verdynt-lockup-dark.png', 'image/png')}" alt="Verdynt/OS"></div>
${d.sections.join('\n')}
<div class="foot">${d.source ? `<p>${d.source}</p>` : ''}<p>The full guide, with common questions: ${SITE}/${g.slug}. Have your insurer and attorney review any procedure before you adopt it.</p></div>
</body></html>`;
}

async function build(browser, g) {
  const page = await browser.newPage();
  const d = await readGuide(page, g);
  await page.setContent(html(g, d), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(OUT_DIR, `${g.slug}.pdf`);
  await page.pdf({ path: out, format: 'Letter', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;font-size:7.5pt;color:#4B6570;padding:0 14mm;display:flex;justify-content:space-between;font-family:Helvetica,Arial,sans-serif"><span>${d.title} &middot; ${SITE}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>` });
  await page.close();
  return out;
}

module.exports = { GUIDES, build };

if (require.main === module) {
  (async () => {
    const want = process.argv.slice(2);
    const list = want.length ? GUIDES.filter((g) => want.includes(g.slug)) : GUIDES;
    if (want.length && list.length !== want.length) throw new Error(`Not in GUIDES: ${want.filter((w) => !GUIDES.some((g) => g.slug === w)).join(', ')}`);
    const browser = await pw.chromium.launch();
    for (const g of list) {
      const out = await build(browser, g);
      console.log(`Wrote ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
    }
    await browser.close();
  })().catch((err) => { console.error(err); process.exit(1); });
}
