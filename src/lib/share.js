'use strict';

// The words on each page's share image (the picture a link preview shows on LinkedIn, X, Slack or in a text): a small
// line above, the page's search phrase as the headline, and one short line under it. scripts/share-images.js draws the
// images from this list into public/site/img/share/<file>.png; lib/seo.js uses a page's own image when its file is
// there, and the site-wide share.png otherwise. Add a page here, run the script, look at the image, commit the PNG.
const SOFT = 'Ski area software';
const GUIDE = 'Free guide';
const SHARE = {
  '': { kicker: 'For independent ski areas', headline: 'Ski area management software', sub: 'Run the whole mountain from one screen.' },
  product: { kicker: SOFT, headline: 'Ski resort software', sub: 'Every part of the mountain. Run the parts you need.' },
  'ski-patrol': { kicker: SOFT, headline: 'Ski patrol software', sub: 'Write the report once, at the bedside.' },
  'lift-ticket-software': { kicker: SOFT, headline: 'Lift ticket and season pass software', sub: 'Sell it, scan it at the lift, move on.' },
  'ski-school-software': { kicker: SOFT, headline: 'Ski school software', sub: 'From the first booking to the last pickup.' },
  'ski-rental-software': { kicker: SOFT, headline: 'Ski rental software', sub: 'Every item out, and every item back.' },
  'ski-waiver-software': { kicker: SOFT, headline: 'Online ski waivers', sub: 'Signed on a phone before they drive up.' },
  'lift-maintenance-software': { kicker: SOFT, headline: 'Lift inspection and maintenance software', sub: "Know what's safe to open." },
  'ski-area-pos': { kicker: SOFT, headline: 'Ski area POS', sub: 'A fast ticket window on a busy Saturday.' },
  'online-lift-ticket-sales': { kicker: SOFT, headline: 'Sell lift tickets online', sub: 'Your own ticket shop, selling while you sleep.' },
  'terrain-park-software': { kicker: SOFT, headline: 'Terrain park software', sub: 'Every feature, where it is, and whether it passed.' },
  'attraction-ticketing-software': { kicker: SOFT, headline: 'Zipline, coaster and tubing software', sub: 'Open on the daily check, sold by the time slot.' },
  'ski-area-staff-scheduling': { kicker: SOFT, headline: 'Ski area staff scheduling', sub: 'Every shift covered before the first chair.' },
  'ski-area-risk-management': { kicker: 'For owners, GMs and insurers', headline: 'Ski area risk management', sub: 'When the claim comes, the record is already written.' },
  pricing: { kicker: 'Pricing', headline: 'Ski area software pricing', sub: 'Priced by what you run. 14 days free, no contract.' },
  resources: { kicker: 'Resources', headline: 'Ski area guides and checklists', sub: 'Free and printable, for independent ski areas.' },
  'chairlift-inspection-checklist': { kicker: GUIDE, headline: 'Chairlift daily inspection checklist', sub: 'The pre-opening check and the daily record, printable.' },
  'terrain-park-inspection-checklist': { kicker: GUIDE, headline: 'Terrain park inspection checklist', sub: 'Every jump, rail and landing, and the daily record.' },
  'ski-area-incident-report-guide': { kicker: GUIDE, headline: 'How to write a ski area incident report', sub: 'What to record, what to leave out, and a review checklist.' },
  'how-to-choose-ski-area-software': { kicker: GUIDE, headline: 'How to choose ski area software', sub: 'When to switch, what to compare, and what to ask.' },
  'ski-school-pickup-policy': { kicker: GUIDE, headline: 'Ski school pickup policy template', sub: 'Child pickup and release, step by step.' },
  'lost-child-procedure': { kicker: GUIDE, headline: 'Lost child procedure for ski areas', sub: 'The first minutes, in order, with a drill checklist.' },
  'ski-instructor-pay-scale': { kicker: GUIDE, headline: 'How to build a ski instructor pay scale', sub: 'Levels, steps and rules your instructors can read.' },
  'ski-area-opening-day-checklist': { kicker: GUIDE, headline: 'Ski area opening day checklist', sub: 'Lifts, trails, staff and guests ready for the first chair.' },
  about: { kicker: 'About', headline: 'Software for independent ski areas', sub: 'Verdynt/OS, from Verdynt Consulting Group.' },
  security: { kicker: 'Security', headline: 'Guest and patient information', sub: 'How Verdynt/OS keeps it safe.' },
  contact: { kicker: 'Contact', headline: 'See your mountain on the board', sub: 'Book a 20-minute walkthrough or a 14-day trial.' },
  status: { kicker: 'Service status', headline: 'Is Verdynt/OS working?', sub: 'The service, checked every minute.' },
  privacy: { kicker: 'Legal', headline: 'Privacy policy', sub: 'What Verdynt/OS collects, and why.' },
  terms: { kicker: 'Legal', headline: 'Terms of service', sub: 'The terms for using Verdynt/OS.' },
  'good-day': { kicker: 'Newsletter', headline: 'The Good Day', sub: 'For ski area owners, GMs and patrol directors, every other week.' },
  'good-day/scorecard': { kicker: 'Free tool', headline: 'The Good Day scorecard', sub: "How good is your guest's day? Twelve questions, about five minutes." },
};

/** The image's file name for a page: "home" for Home, slashes as dashes ("good-day-scorecard"). An issue of the Good Day
 * without words of its own here uses the newsletter's image. */
const fileFor = (slug) => (slug === '' ? 'home' : /^good-day\/issue-\d+$/.test(slug) && !(slug in SHARE) ? 'good-day' : String(slug).replace(/\//g, '-'));

module.exports = { SHARE, fileFor };
