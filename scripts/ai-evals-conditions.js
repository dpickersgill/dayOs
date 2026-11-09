'use strict';

// Evaluation fixtures for the conditions writer (lib/conditionswriter.js): six realistic mornings, as the facts gather()
// returns, and the checks a good draft must pass. The evals tests use them with a stand-in model (our assembly, the facts
// guard, labels and fallbacks: conditions.test.js in the evals folder of the tests), and scripts/ai-evals.js runs them
// against the real model, opt in, when ASSISTANT_API_KEY is set. Kept here, not with the tests, so the script needs
// nothing that the release leaves out.
const writer = require('../src/lib/conditionswriter');

const lift = (name, status) => ({ name, status, word: { open: 'Open', hold: 'On hold', wind_hold: 'Wind hold', closed: 'Closed' }[status] });
const base = (o) => ({
  mountain: 'Pine Knob', date: '2027-01-16', weekday: 'Saturday', status: 'open', day_set: true, opens: '09:00', closes: '16:00', day_note: null,
  lifts: [], lifts_open: 0, lifts_total: 0, trails_open: 0, trails_total: 0, open_trails: [], trail_names: [], groomed: [],
  new_snow_in: null, new_snow_from: null, base_in: null, surface: null, weather: null, events: [], ...o,
});
const counts = (f) => ({ ...f, lifts_open: f.lifts.filter((l) => l.status === 'open').length, lifts_total: f.lifts.length, trails_open: f.open_trails.length, trails_total: f.trail_names.length });

const FIXTURES = [
  {
    key: 'powder', title: 'Powder day',
    facts: counts(base({
      lifts: [lift('Summit Quad', 'open'), lift('Easy Rider Chair', 'open'), lift('Lodge Carpet', 'open')],
      trail_names: ['Bunny Hollow', 'Ridge Run', 'Widowmaker', 'Fox Glade', 'Lower Main'], open_trails: ['Bunny Hollow', 'Ridge Run', 'Widowmaker', 'Fox Glade', 'Lower Main'],
      groomed: ['Bunny Hollow', 'Lower Main'], new_snow_in: 14, new_snow_from: 'crew', base_in: 48, surface: 'powder',
      weather: { temp_f: 18, wind_mph: 5, gust_mph: null, sky: 'snow' },
    })),
    voice: ['Bluebird Monday! 14 inches of cold smoke on the Ridge. Get here early, folks.'],
    must: [/14/, /48/], mustNot: [/rain/i],
  },
  {
    key: 'wind', title: 'Wind hold on the summit',
    facts: counts(base({
      lifts: [lift('Summit Quad', 'wind_hold'), lift('Easy Rider Chair', 'open')],
      trail_names: ['Bunny Hollow', 'Ridge Run', 'Widowmaker'], open_trails: ['Bunny Hollow', 'Ridge Run'], groomed: ['Ridge Run'], base_in: 36,
      weather: { temp_f: 22, wind_mph: 35, gust_mph: 55, sky: 'clear' },
    })),
    must: [/hold/i, /Summit Quad/], mustNot: [/Summit Quad (is )?(open|spinning|running)/i],
  },
  {
    key: 'rain', title: 'Rain',
    facts: counts(base({
      lifts: [lift('Summit Quad', 'open'), lift('Easy Rider Chair', 'open')],
      trail_names: ['Bunny Hollow', 'Ridge Run', 'Widowmaker'], open_trails: ['Bunny Hollow', 'Ridge Run'], groomed: ['Bunny Hollow', 'Ridge Run'], base_in: 24, surface: 'wet granular',
      weather: { temp_f: 38, wind_mph: 10, gust_mph: null, sky: 'rain' },
    })),
    must: [/rain/i], mustNot: [/powder day|fresh snow|new snow/i],
  },
  {
    key: 'early', title: 'Early season, one lift',
    facts: counts(base({
      date: '2026-11-21', weekday: 'Saturday', opens: '09:00', closes: '15:00', day_note: 'Opening weekend. Snowmaking continues.',
      lifts: [lift('Summit Quad', 'closed'), lift('Easy Rider Chair', 'open')],
      trail_names: ['Bunny Hollow', 'Ridge Run', 'Widowmaker', 'Fox Glade'], open_trails: ['Bunny Hollow'], groomed: ['Bunny Hollow'], base_in: 18, surface: 'machine made',
    })),
    must: [/\b1\b|one lift/i, /Easy Rider Chair/], mustNot: [/Widowmaker (is )?open/i],
  },
  {
    key: 'closed', title: 'Closed day',
    facts: counts(base({
      status: 'closed', opens: null, closes: null, day_note: 'Closed for high winds.',
      lifts: [lift('Summit Quad', 'closed'), lift('Easy Rider Chair', 'closed')],
      trail_names: ['Bunny Hollow', 'Ridge Run'], open_trails: [], base_in: 30,
      weather: { temp_f: 12, wind_mph: 45, gust_mph: 70, sky: 'overcast' },
    })),
    must: [/closed/i], mustNot: [/\bopen (today|9|from)/i, /lifts run/i],
  },
  {
    key: 'holiday', title: 'Holiday with events',
    facts: counts(base({
      date: '2027-02-15', weekday: 'Monday', opens: '08:30', closes: '21:00', day_note: 'Presidents Day: night skiing until 9.',
      lifts: [lift('Summit Quad', 'open'), lift('Easy Rider Chair', 'open'), lift('Lodge Carpet', 'open')],
      trail_names: ['Bunny Hollow', 'Ridge Run', 'Widowmaker', 'Fox Glade'], open_trails: ['Bunny Hollow', 'Ridge Run', 'Widowmaker', 'Fox Glade'],
      groomed: ['Bunny Hollow', 'Ridge Run', 'Fox Glade'], new_snow_in: 2, base_in: 40,
      weather: { temp_f: 26, wind_mph: 8, gust_mph: null, sky: 'partly' },
      events: [{ title: 'Torchlight parade', time: '18:30' }, { title: 'Kids race on Bunny Hollow', time: '10:00' }],
    })),
    must: [/Torchlight parade/i, /9|night/i], mustNot: [],
  },
];

/** The checks every draft of every fixture must pass. Returns problems (empty when it passes). */
function checks(fx, out) {
  const d = out.draft;
  const problems = [...writer.check(d, fx.facts)];
  const all = [d.note, d.snow_report, d.social, d.email_subject, d.email_body].join('\n');
  if (/[—–]/.test(all)) problems.push('an em dash');
  if (!/^Hi \{first_name\},/.test(d.email_body)) problems.push('the email does not start "Hi {first_name},"');
  if (d.social.length > writer.SOCIAL_MAX) problems.push('social post too long');
  for (const re of fx.must) if (!re.test(all)) problems.push(`missing ${re}`);
  for (const re of fx.mustNot) if (re.test(all)) problems.push(`should not say ${re}`);
  if (/patrol|injur|accident|incident/i.test(all)) problems.push('mentions patrol or injuries');
  return problems;
}

module.exports = { feature: 'conditions writer', FIXTURES, checks, run: (fx, call) => writer.draftFrom(fx.facts, { voice: fx.voice || [], call }) };
