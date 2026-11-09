'use strict';

// Builds the printable PDFs for four guides: public/site/<slug>.pdf, from the parts of each page marked
// <!--PDF--> ... <!--/PDF--> in src/site/guide-*.html, so the PDF never drifts from what the page says.
// Run it after changing one of those pages:  node scripts/guide-pdfs.js   (or: node scripts/guide-pdfs.js <slug> ...)
// Needs Playwright (Chromium). The brand fonts are embedded from public/fonts, so the PDF looks the same everywhere.
// Follows scripts/scorecard-pdf.js. The older checklists (chairlift, terrain park) are built by scripts/checklist-pdf.js.
const fs = require('node:fs');
const path = require('node:path');

let pw; try { pw = require('playwright'); } catch (_) { pw = require('/opt/npm-tools/node_modules/playwright'); }

const ROOT = path.join(__dirname, '..');
const font = (f) => `data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'public', 'fonts', f)).toString('base64')}`;

// slug: the page's address and the PDF's name. file: the page template. kicker, title and intro: the masthead.
// note: the one plain line under the masthead. skipLead: leave out the part's own heading and first line (the masthead
// says it). meta: the fill-in line under the masthead (null for none). noSign: the meta line is the sign-off. cols: the checklist in two columns, each department with an owner line.
const GUIDES = [
  { slug: 'ski-school-pickup-policy', file: 'guide-pickup', kicker: 'Ski school template', title: 'Child pickup and release policy',
    intro: 'Fill in the blanks, adjust the wording to your school, and give it to families when they book.', skipLead: true,
    note: 'This is a template, not legal advice. Have your insurer and attorney review it before adopting.' },
  { slug: 'lost-child-procedure', file: 'guide-lostchild', kicker: 'Procedure and drill checklist', title: 'Lost child procedure',
    intro: 'The first 5 minutes, the next 30, the reunion, and the checklist for a drill twice a season.',
    note: 'This is a template. Have your insurer and attorney review it before adopting. Call local law enforcement as your own written policy says, at the time it sets.' },
  { slug: 'ski-instructor-pay-scale', file: 'guide-payscale', kicker: 'Ski school worksheet', title: 'Ski instructor pay scale',
    intro: 'Fill in your own rates. Leave a cell blank if your school does not pay that kind of lesson. Publish the finished ladder to every instructor.', skipLead: true, meta: null,
    note: 'General information, not legal, tax or payroll advice. Check wage and tip rules where you operate with your payroll provider or attorney.' },
  { slug: 'ski-area-opening-day-checklist', file: 'guide-openingday', kicker: 'Checklist', title: 'Ski area opening day checklist', cols: true,
    meta: ['Mountain', 'General manager', 'Opening date'], noSign: true,
    intro: 'One owner per department. Start the "weeks before" items four to six weeks out, and read the "morning of" items aloud at the stand-up.',
    note: 'This checklist is a template. Have your insurer and attorney review it before adopting, and follow your lift manufacturers\' manuals and your state\'s rules first.' },
];

/** The marked parts of a page, with links turned to plain text, ids dropped, and each h3 block kept together. */
function printable({ file, skipLead = false, cols = false }) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'site', `${file}.html`), 'utf8');
  const parts = [...src.matchAll(/<!--PDF-->([\s\S]*?)<!--\/PDF-->/g)].map((m) => m[1]);
  if (!parts.length) throw new Error(`${file}.html has no <!--PDF--> part`);
  return parts.map((p, i) => {
    let html = p.replace(/<a [^>]*>([\s\S]*?)<\/a>/g, '$1').replace(/ id="[^"]*"/g, '').replace(/\{\{[A-Z]+\}\}/g, '');
    if (skipLead && i === 0) html = html.replace(/^\s*<h2[^>]*>[\s\S]*?<\/h2>\s*<p>[\s\S]*?<\/p>/, '');
    // A later part that starts at an h3 (the drill checklist) gets a section heading of its own.
    if (i > 0) html = html.replace(/^(\s*)<h3>([\s\S]*?)<\/h3>/, '$1<h2>$2</h2>');
    if (cols) html = html.replace(/<h3>([\s\S]*?)<\/h3>/g, '<h3>$1 <span class="own">Owner:</span></h3>');
    // Each h3 and what follows it, up to the next heading, is one block that does not split across pages.
    const [head, ...blocks] = html.split(/(?=<h3[ >])/);
    return head + blocks.map((b) => {
      const cut = b.search(/<h2[ >]/);
      return cut < 0 ? `<section class="blk">${b}</section>` : `<section class="blk">${b.slice(0, cut)}</section>${b.slice(cut)}`;
    }).join('');
  }).join('\n');
}

function html(g) {
  // The sign-off line goes after the columns, across the page.
  const body = printable(g);
  const found = (body.match(/<div class="sign">[\s\S]*?<\/div>/) || [''])[0];
  const sign = g.noSign ? '' : found;
  const meta = g.meta === undefined ? ['Mountain', 'Prepared by', 'Date'] : g.meta;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${g.title}</title><style>
@font-face{font-family:'Atkinson Hyperlegible';font-weight:400;src:url('${font('atkinson-hyperlegible-latin-400-normal.woff2')}') format('woff2')}
@font-face{font-family:'Atkinson Hyperlegible';font-weight:700;src:url('${font('atkinson-hyperlegible-latin-700-normal.woff2')}') format('woff2')}
@font-face{font-family:'Barlow Condensed';font-weight:700;src:url('${font('barlow-condensed-latin-700-normal.woff2')}') format('woff2')}
:root{--slate:#12303A;--spruce:#2C7A57;--gold:#D8B672;--gold-wash:#F7F0E1;--line:#C7D9E3;--muted:#4B6570}
@page{size:Letter;margin:13mm 14mm 16mm}
*{box-sizing:border-box}
body{margin:0;font-family:'Atkinson Hyperlegible',Helvetica,Arial,sans-serif;color:var(--slate);font-size:10pt;line-height:1.38}
h1,h2,h3{font-family:'Barlow Condensed','Arial Narrow',sans-serif;font-weight:700;margin:0}
.mast{background:var(--slate);color:#eef4f7;border-radius:8px;padding:12px 16px;border-bottom:5px solid var(--gold)}
.mast .k{color:var(--gold);font-weight:700;font-size:9pt;letter-spacing:.12em;text-transform:uppercase;margin:0 0 3px}
.mast h1{font-size:26pt;line-height:.95;text-transform:uppercase}
.mast p.s{margin:6px 0 0;color:#C7DAE3}
.meta{display:flex;gap:16px;margin:10px 0 2px;font-size:9.5pt}
.meta span{flex:1;border-bottom:1px solid var(--slate);padding-bottom:2px}
.note{margin:8px 0 4px;padding:6px 10px;background:var(--gold-wash);border-left:4px solid var(--gold);font-size:9pt}
.body{${g.cols ? 'column-count:2;column-gap:9mm;' : ''}}
h2{font-size:15pt;color:var(--spruce);border-bottom:2px solid var(--gold);padding-bottom:2px;margin-top:10px;text-transform:uppercase;break-after:avoid;column-span:all}
h3{font-size:12.5pt;margin-top:8px;break-after:avoid}
p{margin:5px 0}
ul,ol{margin:5px 0;padding-left:18px}
li{margin:3px 0;break-inside:avoid}
${g.cols ? 'h3,.body p{break-after:avoid}' : '.blk{break-inside:avoid}'}
.own{float:right;font-family:'Atkinson Hyperlegible',sans-serif;font-weight:400;font-size:8.5pt;color:var(--muted);width:42%;border-bottom:1px solid var(--slate);margin-top:6px}
.checklist{list-style:none;padding:0;margin:4px 0 6px;border-top:1px solid var(--line)}
.checklist li{position:relative;margin:0;padding:4px 0 4px 20px;border-bottom:1px solid var(--line)}
.checklist li:before{content:'';position:absolute;left:1px;top:6px;width:10px;height:10px;border:1.5px solid var(--slate);border-radius:2px}
.sign{display:flex;gap:16px;margin-top:8px;break-inside:avoid;column-span:all}
.sign span{flex:1;border-top:1px solid var(--slate);padding-top:3px;font-size:9pt;color:var(--muted);margin-top:18px}
.tpl{border:1px dashed var(--slate);border-radius:6px;padding:10px 14px}
.tpl h3{margin-top:0}
.tpl p{margin:7px 0}
.blank{display:inline-block;min-width:11em;height:1em;border-bottom:1px solid var(--slate);vertical-align:-2px}
.blank.sm{min-width:3.5em}
.tpl-note{font-size:9pt;color:var(--muted)}
.sheet table{width:100%;border-collapse:collapse;margin:4px 0 8px}
.sheet th,.sheet td{border:1px solid var(--slate);padding:5px 7px;text-align:left;vertical-align:top;font-size:9.5pt}
.sheet thead th{background:var(--gold-wash)}
.sheet tbody th{font-weight:400;width:32%}
.sheet td{height:19px}
</style></head><body>
<div class="mast"><p class="k">${g.kicker}</p><h1>${g.title}</h1><p class="s">${g.intro}</p></div>
${meta ? `<div class="meta">${meta.map((m) => `<span>${m}:</span>`).join('')}</div>` : ''}
<p class="note">${g.note}</p>
<div class="body">${found ? body.replace(found, '') : body}</div>
${sign}
</body></html>`;
}

// The footer on every page: the Verdynt/OS name, small, the guide's address and the page number.
const footer = (g) => `<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:7pt;color:#4B6570;padding:0 14mm;display:flex;justify-content:space-between">
<span>Verdynt/OS &middot; www.runmyresort.com/${g.slug}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

async function main() {
  const want = process.argv.slice(2);
  const list = want.length ? GUIDES.filter((g) => want.includes(g.slug)) : GUIDES;
  const browser = await pw.chromium.launch();
  for (const g of list) {
    const page = await browser.newPage();
    await page.setContent(html(g), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(ROOT, 'public', 'site', `${g.slug}.pdf`);
    await page.pdf({ path: out, format: 'Letter', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>', footerTemplate: footer(g) });
    await page.close();
    console.log(`Wrote ${path.relative(process.cwd(), out)}`);
  }
  await browser.close();
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
module.exports = { GUIDES, printable };
