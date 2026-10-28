'use strict';
// Every stylesheet closes each block it opens. A merge can drop one closing brace at the end of a @media block, and
// everything after it then silently stops applying (it happened once to Sell's Activities tab).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'public', 'css');
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
  test(`${file} closes every block it opens`, () => {
    const css = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
    let depth = 0;
    let line = 1;
    for (const ch of css) {
      if (ch === '\n') line += 1;
      else if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; assert.ok(depth >= 0, `${file}: a closing brace with nothing open, line ${line}`); }
    }
    assert.strictEqual(depth, 0, `${file}: ${depth} block(s) never closed`);
  });
  test(`${file}: each section header starts at the top level`, () => {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    let depth = 0;
    lines.forEach((l, i) => {
      if (/^\/\* ---- /.test(l)) assert.strictEqual(depth, 0, `${file}: line ${i + 1} starts a section inside an open block`);
      const t = l.replace(/\/\*[\s\S]*?\*\//g, '');
      depth += (t.match(/{/g) || []).length - (t.match(/}/g) || []).length;
    });
  });
}
