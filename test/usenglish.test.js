'use strict';

// Verdynt/OS is written in US English. This fails when a British spelling comes back in text people read: the app's
// screens, the website, help, What's new and the roadmap. Stored values keep their spelling ("cancelled" as a status)
// and are left alone: a word next to a quote, after a dot, or joined to an underscore is code, not text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BRITISH = ['colour', 'colours', 'coloured', 'cancelled', 'cancelling', 'metre', 'metres', 'litre', 'litres', 'kilometre', 'kilometres', 'authorise', 'authorised',
  'organise', 'organised', 'organising', 'organisation', 'organisations', 'personalise', 'personalised', 'grey', 'programme', 'programmes', 'behaviour', 'centre', 'centres',
  'centred', 'neighbour', 'neighbouring', 'fulfil', 'fulfilment', 'honour', 'honoured', 'recognise', 'recognised', 'labelled', 'labelling', 'favourite', 'favourites',
  'travelling', 'traveller', 'catalogue', 'analyse', 'realise', 'summarise', 'customise', 'customised', 'prioritise', 'minimise', 'optimise', 'finalise', 'apologise',
  'enrolment', 'enrol', 'judgement', 'defence', 'licence', 'whilst', 'amongst', 'learnt', 'cheque', 'labour', 'enquiry', 'enquiries', 'enquire'];
const WORD = new RegExp(`(?<![A-Za-z0-9_$.\\-])(${BRITISH.join('|')})(?![A-Za-z0-9_$])`, 'gi');

const ROOT = path.join(__dirname, '..');
function filesIn(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['vendor', 'node_modules', 'fonts'].includes(e.name)) out.push(...filesIn(p, ext)); } else if (ext.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

test('text people read is in US English', () => {
  const files = [...filesIn('public/js', ['.js']), ...filesIn('public', ['.html']).filter((f) => !f.includes('/js/')), ...filesIn('src/site', ['.html']), 'src/release/changelog.json', 'src/release/roadmap.json'];
  const found = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(WORD)) {
      const a = m.index; const b = a + m[0].length;
      const before = text[a - 1] || ''; const after = text[b] || '';
      if (`'"\``.includes(before) && `'"\``.includes(after)) continue; // a stored value
      if (f.endsWith('.js') && /^\s*[:(=]/.test(text.slice(b, b + 3)) && !/^\s*=\s/.test(text.slice(b, b + 4))) continue; // a key or a call
      if (f.endsWith('.js') && /^\s*[,}]/.test(text.slice(b, b + 2)) && /[{,]\s*$/.test(text.slice(Math.max(0, a - 3), a))) continue; // { organisation }
      const line = text.slice(0, a).split('\n').length;
      if (/spelling-ok/.test(text.split('\n')[line - 1])) continue; // a line that maps stored values to US words
      found.push(`${f}:${line}: ${m[0]}`);
    }
  }
  assert.deepEqual(found, [], 'British spellings found; use the US spelling (color, canceled, organization, center, gray)');
});
