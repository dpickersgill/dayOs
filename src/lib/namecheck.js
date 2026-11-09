'use strict';

// The name check that the AI writers share (2026.11.15 review): the morning brief (lib/briefwrite.js) and the conditions
// writer (lib/conditionswriter.js). A model may only name what the facts name. Every capitalized word in its text must be
// one of these:
//   - part of a name in the facts (a lift, trail, park feature, area, event, the mountain), matched as whole words,
//     longest first, so "Grizzly Bear Bowl" is not passed because a lift is called "Bear";
//   - a word the caller allows (the words of the mountain's own name, a manager's note);
//   - a weekday, a month, a holiday, AM or PM, "I";
//   - an ordinary word at the start of a sentence ("Fresh snow today."), from COMMON below, or one the same text also
//     writes in lower case ("Groomers ... the groomers").
// Anything else (a made-up person, place or lift) is returned, as the run of capitalized words it sits in.
//
// Kept small on purpose: it is a guard, not a spell checker. A false alarm sends the draft round once more and then to
// the plain template, which is safe; a missed name is not.

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'];
// Allowed anywhere: calendar words, clock words, and the US holidays a mountain is busy on.
const ALWAYS = new Set([
  ...WEEKDAYS, ...WEEKDAYS.map((d) => `${d}s`), ...MONTHS, 'am', 'pm', 'i', 'f', 'mph',
  'thanksgiving', 'christmas', 'hanukkah', 'kwanzaa', 'easter', 'halloween', 'presidents', 'presidents\'', 'mlk', 'new', 'year', 'year\'s', 'years', 'eve', 'day',
]);

// Ordinary words that start a sentence in a conditions update or a morning brief. No word here is also a common first
// name ("Will", "Bill", "Grant", "Mark", "Holly", "Dawn", "Summer" are left out on purpose).
const COMMON = new Set(`
a about above after again all also an and another any are around as at back be because before below best big both bring
but by call can check cold come conditions cozy crisp crew decide do don't down drop during each early enjoy even every
expect expected few fill find first for fresh from get give go good grab great groomed groomers grooming happy have
he heads hello here here's hey hi high how if in is it it's its just last late let's lifts light like look looking lots
low make many more morning most much need needs new next nice night no none not nothing now of off on once one only
open opening or our out over overnight perfect plan plenty please publish put quick quiet rain read remember running
see she she's short since skies sky sleds slow snow so some soft split spring start stay still stop sunny surface take
temperatures thank thanks that that's the their then there there's these they they're this those through tickets to
today today's tomorrow tonight top two under up upper lower us use wait warm watch we we'll we're we've weather weekend
welcome well what when where which while who why wind with winter yes yesterday yet you you'll you're your
zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen
nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred dozen half
assign clear add raise visitors lessons lesson staff shifts trails terrain park patrol instructors refunds ticket online
suggested yesterday's simple these weekly gusts forecast cases case free fun folks friends powder corduroy groomed bluebird
snowmaking night kids family families parking lodge rentals rental base summit lot it'll
set turn ask tell keep move review confirm cover post send update contact order schedule book close mark note remind
sweep shift instructor class classes students waitlist refund revenue orders sold sales feature features need area areas
lift trail chair chairs run runs drizzle fog overcast partly showers thunderstorms mixed
bundle dress layer ski skiing skiers riders ride hit head carve dig beat catch join celebrate try wear pack drive arrive
please heads-up reminder note update tip
`.split(/\s+/).filter(Boolean));

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = /[A-Za-z][A-Za-z'’-]*/g;
const norm = (w) => w.toLowerCase().replace(/’/g, '\'').replace(/'s$/, '').replace(/-+$/, '');

/** Masks every known name in the text, as whole words, longest first: its letters and digits become §, the rest stays. */
function maskNames(text, names) {
  let t = String(text);
  const list = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const n of list) {
    const re = new RegExp(`(?<![A-Za-z0-9'’-])${esc(n).replace(/\s+/g, '\\s+')}(?:['’]s)?(?![A-Za-z0-9-])`, 'gi');
    t = t.replace(re, (m) => m.replace(/[A-Za-z0-9'’]/g, '§')); // letters only: a full stop inside a note still ends its sentence
  }
  return t;
}

/** True when the word at index i starts a sentence (or a line, a field, or follows a colon). */
function startsSentence(text, i) {
  return /(?:^|[.!?:;\n])[\s"'“‘(\[*•-]*$/.test(text.slice(0, i));
}

/**
 * The capitalized words in text that are not in the facts. opts: { names: [...], words: [...] } (words: single words
 * allowed anywhere, any case). Returns [{ text, words }], one per run of capitalized words holding an unknown one.
 */
function unknownNames(text, { names = [], words = [] } = {}) {
  const src = String(text || '');
  const masked = maskNames(src, names);
  const allowed = new Set(words.map(norm));
  const lowerUsed = new Set([...src.matchAll(/\b[a-z][a-z'’-]*/g)].map((m) => norm(m[0])));
  const toks = [...masked.matchAll(WORD)].map((m) => ({ w: m[0], i: m.index, end: m.index + m[0].length }));
  const out = []; let run = null;
  const flush = () => { if (run && run.bad) out.push({ text: src.slice(run.i, run.end).replace(/\s+/g, ' '), words: run.badWords }); run = null; };
  for (const t of toks) {
    if (!/^[A-Z]/.test(t.w)) { flush(); continue; }
    const gap = run ? masked.slice(run.end, t.i) : null;
    if (run && !/^[\s§]+$/.test(gap)) flush(); // a known name inside a run stays in it: "Grizzly Bear Bowl"
    const lw = norm(t.w);
    const start = startsSentence(masked, t.i);
    const common = (x) => COMMON.has(x) || lowerUsed.has(x);
    const fine = ALWAYS.has(lw) || allowed.has(lw) || (start && (common(lw) || (lw.includes('-') && lw.split('-').every(common))));
    if (!run) { const back = /§[\s§]*$/.exec(masked.slice(0, t.i)); run = { i: back ? back.index : t.i, end: t.end, bad: false, badWords: [] }; }
    run.end = t.end;
    if (!fine) { run.bad = true; run.badWords.push(t.w); }
  }
  flush();
  return out;
}

/** Links and addresses: a draft or a brief never carries one. */
const LINK = /\bhttps?:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.[\w.-]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|edu|gov|io|co|us|ca|info|biz|app|dev|ly|me|example|test|ski|xyz|site|online|shop)\b|\]\(/i;
const hasLink = (text) => LINK.test(String(text || ''));

module.exports = { unknownNames, maskNames, hasLink, startsSentence, COMMON, ALWAYS };
