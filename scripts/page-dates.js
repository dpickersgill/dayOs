'use strict';

// Writes src/release/page-dates.json: for each website page (its address, "" for Home), the date its template last
// changed in git. The sitemap's <lastmod> and the pages' dateModified read it, so a deploy does not make every page look
// new to search engines. Run by scripts/stamp-build.js when a release zip is made, or on its own:
//   node scripts/page-dates.js
// A template with changes not yet committed gets today's date. Without git (or with no history for a file) the page is
// left out, and the website falls back to the file's own date.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const OUT = path.join(root, 'src', 'release', 'page-dates.json');
const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

/** { slug: 'YYYY-MM-DD' } for every page in src/routes/site.js PAGES (the Good Day issues included). */
function build() {
  const { PAGES } = require('../src/routes/site');
  const today = new Date().toISOString().slice(0, 10);
  const pages = {};
  for (const [slug, name] of Object.entries(PAGES)) {
    const file = path.join('src', 'site', `${name}.html`);
    if (!fs.existsSync(path.join(root, file))) continue;
    try {
      if (git(['status', '--porcelain', '--', file])) { pages[slug] = today; continue; }
      const d = git(['log', '-1', '--format=%cs', '--', file]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) pages[slug] = d;
    } catch (_) { /* not a git copy: leave it to the file date */ }
  }
  return pages;
}

function write(out = OUT) {
  const pages = build();
  fs.writeFileSync(out, `${JSON.stringify({ written_at: new Date().toISOString(), pages }, null, 2)}\n`);
  return { out, count: Object.keys(pages).length };
}

module.exports = { build, write, OUT };

if (require.main === module) {
  const r = write(process.argv[2] || OUT);
  console.log(`Wrote ${path.relative(process.cwd(), r.out)}: dates for ${r.count} pages`);
  // site.js opens nothing at load, but end the database pool in case a later change does
  require('../src/db').pool.end().catch(() => {});
}
