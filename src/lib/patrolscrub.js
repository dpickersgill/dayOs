'use strict';

// Questions a patrol login types into the assistant (2026.11.11, privacy). The assistant answers from Help, so it never
// needs to know who a patient is. Before a patroller's question is sent to Anthropic or written to assistant_log, the
// obvious ways to name a person are removed: email addresses, phone numbers, dates, ages, and capitalized word pairs
// that look like a person's name (a pair is kept only when both words appear in the Help text, like "Patrol Records").
// This is a filter for obvious patterns, not a guarantee; the screen also asks patrollers not to type patient details.
const fs = require('fs');
const path = require('path');

const MARK = '[removed]';
let vocab = null;
function helpWords() {
  if (vocab) return vocab;
  vocab = new Set();
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'help-content.js'), 'utf8');
    for (const w of src.match(/[A-Za-z][a-z]+/g) || []) vocab.add(w.toLowerCase());
  } catch (_) { /* no Help text: every capitalized pair is treated as a name */ }
  return vocab;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const DATE = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi;
const AGE = /\b\d{1,3}\s*(?:-|\s)?(?:yo|y\/o|yrs?|years?)(?:[\s-]*old)?\b|\bage[ds]?\s*\d{1,3}\b/gi;
const PAIR = /\b([A-Z][a-z'’-]+)(\s+[A-Z][a-z'’-]+)+\b/g;

/** The question with obvious names, contact details, dates and ages replaced by [removed]. */
function scrub(question) {
  const known = helpWords();
  return String(question || '')
    .replace(EMAIL, MARK).replace(PHONE, MARK).replace(DATE, MARK).replace(AGE, MARK)
    .replace(PAIR, (m) => (m.split(/\s+/).every((w) => known.has(w.toLowerCase().replace(/['’-].*$/, ''))) ? m : MARK));
}

/** Is this login patrol (the patrol role, or a person on the patrol roster)? */
const isPatrol = (auth) => Boolean(auth) && (auth.role === 'patrol' || Boolean(auth.onPatrol));

module.exports = { scrub, isPatrol, MARK };
