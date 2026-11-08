'use strict';

// The Good Day scorecard: twelve questions a mountain owner or patrol director answers about the guest's good day, each
// scored 2 (yes, every day), 1 (partly, or some days) or 0 (no, or not sure). One list of questions feeds the web page
// (/good-day/scorecard, scored in the browser by public/site/site.js), the printable PDF (scripts/scorecard-pdf.js
// writes public/site/good-day-scorecard.pdf) and the results email a reader can ask for. Nothing is stored unless the
// reader chooses to email the results (routes/site.js, POST /api/v1/site/contact with kind "scorecard").
const { esc } = require('./format');

const AREAS = [
  { key: 'arrive', name: 'Arrival and tickets' },
  { key: 'learn', name: 'Lessons' },
  { key: 'lifts', name: 'Lifts and opening checks' },
  { key: 'patrol', name: 'Patrol response and records' },
  { key: 'park', name: 'Terrain park inspections' },
  { key: 'staff', name: 'Staff and scheduling' },
  { key: 'tell', name: 'Communication and conditions' },
];

// q: the question. next: the plain next step when the answer is not "yes, every day".
const QUESTIONS = [
  { area: 'arrive', q: 'Can a guest pick a day online, see that day\'s price, and buy a ticket without calling or standing in line?', next: 'Sell tickets online by the day, with a daily limit, so the window only has to hand them over.' },
  { area: 'arrive', q: 'Is every waiver signed before the guest reaches the counter, and can staff find it in seconds?', next: 'Send the waiver link with every online sale, and keep a counter tablet for the rest.' },
  { area: 'learn', q: 'Can a parent book a lesson at the right level for each child, and pay once?', next: 'Put level questions in front of booking, so each child lands in the lesson that fits.' },
  { area: 'learn', q: 'Does every instructor know their students, levels and meeting place before the lesson starts?', next: 'Give instructors their lineup on a phone before the lesson, not on a sheet at the hut.' },
  { area: 'lifts', q: 'Is every lift\'s pre-opening inspection recorded the same day, with who did it and when?', next: 'Record each lift check on a phone at the lift, with the name and time kept, and stop using clipboards.' },
  { area: 'lifts', q: 'Does a failed inspection stop a lift from being opened until a passing one is recorded?', next: 'Make a failed check hold the lift closed in your system, so no one opens it from memory.' },
  { area: 'patrol', q: 'When a call comes in, do the right patrollers know at once where to go?', next: 'Send calls to patrollers\' phones with the location, and keep the call timeline as it happens.' },
  { area: 'patrol', q: 'Is every patient care report complete, timed and reviewed before it is filed?', next: 'Write reports at the bedside with times stamped, and review each one against a checklist before filing.' },
  { area: 'park', q: 'Is every terrain park feature inspected each day, with a record of what was open?', next: 'Inspect features on a phone each morning, and close a feature in the record when it fails.' },
  { area: 'staff', q: 'Is every shift covered before the first chair, without a round of phone calls?', next: 'Publish the schedule a week ahead, and let staff ask for and take shift cover themselves.' },
  { area: 'staff', q: 'Do you know whose certifications run out this season, before they do?', next: 'Keep certifications with expiry dates, and look at who expires this season before you schedule them.' },
  { area: 'tell', q: 'When a lift goes on hold, does your public conditions page change within minutes?', next: 'Link lift and trail status to your conditions page, so one change on the hill updates what guests see.' },
];

const ANSWERS = [{ v: 2, label: 'Yes, every day' }, { v: 1, label: 'Partly, or some days' }, { v: 0, label: 'No, or not sure' }];
const MAX = QUESTIONS.length * 2;

// Where the total lands, highest first.
const BANDS = [
  { min: 20, title: 'Your good day is mostly designed.', line: 'The day runs the same way whoever is working. Tighten the lowest area below, then write down how it should run.' },
  { min: 12, title: 'The good day happens, but it leans on people remembering.', line: 'Most days go well because the right people are on. Start with the lowest area below: it is where a busy Saturday breaks first.' },
  { min: 0, title: 'The good day depends on who is working.', line: 'Pick one area below and write down how it should run, then put it where the crew works. One area this month is enough.' },
];

/** A reader's answers, one 0, 1 or 2 per question in order. Returns null when they are not a full, valid set. */
function valid(scores) {
  return Array.isArray(scores) && scores.length === QUESTIONS.length && scores.every((s) => [0, 1, 2].includes(s)) ? scores : null;
}

/** Totals, the band, each area and the next steps for every answer short of "yes, every day" (lowest first). */
function score(scores) {
  if (!valid(scores)) return null;
  const total = scores.reduce((a, b) => a + b, 0);
  const band = BANDS.find((b) => total >= b.min);
  const areas = AREAS.map((a) => {
    const idx = QUESTIONS.map((q, i) => (q.area === a.key ? i : -1)).filter((i) => i >= 0);
    return { key: a.key, name: a.name, score: idx.reduce((t, i) => t + scores[i], 0), max: idx.length * 2 };
  });
  const steps = QUESTIONS.map((q, i) => ({ i, area: AREAS.find((a) => a.key === q.area).name, score: scores[i], next: q.next }))
    .filter((s) => s.score < 2).sort((a, b) => a.score - b.score || a.i - b.i);
  return { total, max: MAX, band, areas, steps };
}

/** The results as plain text, for the email and the lead: only our own words and the numbers, nothing the reader typed. */
function resultsText(scores) {
  const r = score(scores);
  if (!r) return '';
  const lines = [`Your Good Day score: ${r.total} of ${r.max}.`, '', r.band.title, r.band.line, '', 'By area:'];
  for (const a of r.areas) lines.push(`- ${a.name}: ${a.score} of ${a.max}`);
  if (r.steps.length) {
    lines.push('', 'Next steps, most urgent first:');
    r.steps.slice(0, 6).forEach((s, n) => lines.push(`${n + 1}. ${s.area}: ${s.next}`));
  }
  return lines.join('\n');
}

/** The questions as a web form (the page) or as a printed sheet with boxes to tick (the PDF). */
function questionsHtml({ print = false } = {}) {
  let n = 0;
  return AREAS.map((a) => {
    const qs = QUESTIONS.map((q, i) => ({ ...q, i })).filter((q) => q.area === a.key);
    const items = qs.map((q) => {
      n += 1;
      if (print) {
        return `<li class="pq"><p><b>${n}.</b> ${esc(q.q)}</p><ul class="pa">${ANSWERS.map((x) => `<li><span class="box"></span>${esc(x.label)} <i>(${x.v})</i></li>`).join('')}</ul></li>`;
      }
      return `<fieldset class="sc-q" data-area="${esc(a.key)}" data-next="${esc(q.next)}">
          <legend><span class="sc-n">${n}.</span> ${esc(q.q)}</legend>
          <div class="sc-opts">${ANSWERS.map((x) => `<label><input type="radio" name="q${q.i}" value="${x.v}" required><span>${esc(x.label)}</span></label>`).join('')}</div>
        </fieldset>`;
    }).join(print ? '' : '\n        ');
    return print
      ? `<section class="parea"><h2>${esc(a.name)}</h2><ol class="pqs" start="${n - qs.length + 1}">${items}</ol></section>`
      : `<section class="sc-area" data-area="${esc(a.key)}" data-name="${esc(a.name)}" aria-labelledby="sc-a-${esc(a.key)}">
        <h2 id="sc-a-${esc(a.key)}">${esc(a.name)}</h2>
        ${items}
      </section>`;
  }).join('\n      ');
}

/** The bands, for the page script (data attributes) and the printed key. */
const bandsHtml = () => BANDS.map((b, i) => `<li data-min="${b.min}" data-title="${esc(b.title)}" data-line="${esc(b.line)}"><b>${b.min} to ${i === 0 ? MAX : BANDS[i - 1].min - 1}:</b> ${esc(b.title)}</li>`).join('');

module.exports = { AREAS, QUESTIONS, ANSWERS, BANDS, MAX, valid, score, resultsText, questionsHtml, bandsHtml };
