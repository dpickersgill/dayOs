// Jump to also finds the pages inside apps: the tabs of row 1 and row 2 (Opening checks in Patrol, Lift inspections in
// Mountain status, Daily map in Terrain park). Each entry: [app, title, address, words, who]. who (optional) says who
// may open that page, beyond opening the app: a function of { manager, role, school, patrol } where patrol is the
// person's Patrol features (null when not known yet). Only entries for apps the person may open are offered.

const mgr = (w) => w.manager;
const counter = (w) => w.manager || w.role === 'counter';
const school = (level) => (w) => w.manager || (w.role === 'instructor' && (RANK[w.school] || 0) >= RANK[level]);
const RANK = { instructor: 1, supervisor: 2, director: 3 };
// A Patrol page that needs a Patrol feature: shown once the features are known (they load when Jump to opens).
const feature = (f) => (w) => w.manager || Boolean(w.patrol && w.patrol.features && w.patrol.features.includes(f));
const patrolFlag = (k) => (w) => w.manager || Boolean(w.patrol && w.patrol[k]);

export const SUB_PAGES = [
  // Mountain status
  ['conditions', 'Status', '#/conditions?tab=status', 'lifts trails open closed'],
  ['conditions', 'Grooming', '#/conditions?tab=grooming', 'groomer grooming plan snowcat'],
  ['conditions', 'Snow and weather', '#/conditions?tab=snow', 'snow depth weather'],
  ['conditions', 'Maintenance', '#/conditions?tab=maint', 'repair'],
  ['conditions', 'Work orders', '#/conditions?tab=maint&sub=orders', 'repair report a problem maintenance'],
  ['conditions', 'Lift inspections', '#/conditions?tab=maint&sub=checks', 'opening check lift inspection daily'],
  ['conditions', 'Recurring jobs', '#/conditions?tab=maint&sub=pm', 'preventive maintenance service'],
  ['conditions', 'Fleet', '#/conditions?tab=maint&sub=fleet', 'machines vehicles hours'],
  ['conditions', 'Reports', '#/conditions?tab=reports', 'daily report handoff'],
  // Terrain park
  ['park', 'Daily map', '#/park?tab=layout', 'park map features placed today inspect'],
  ['park', 'Features', '#/park?tab=features', 'rails jumps boxes catalog'],
  ['park', 'Areas', '#/park?tab=areas', 'open an area sign off close'],
  // Patrol (section, then the page)
  ['patrol', 'Board', '#/patrol/now?tab=board', 'patrol home'],
  ['patrol', 'On duty', '#/patrol/now?tab=duty', 'sign in duty'],
  ['patrol', 'Dispatch', '#/patrol/now?tab=dispatch', 'calls radio', feature('dispatch')],
  ['patrol', 'Map', '#/patrol/now?tab=map', 'incident map'],
  ['patrol', 'Opening checks', '#/patrol/now?tab=opening', 'opening check runs open hold rope'],
  ['patrol', 'Closing sweep', '#/patrol/now?tab=sweep', 'sweep clear closing'],
  ['patrol', 'Avalanche', '#/patrol/now?tab=avalanche', 'avalanche control', patrolFlag('avalanche')],
  ['patrol', 'Daily log', '#/patrol/now?tab=log', 'log day'],
  ['patrol', 'All cases', '#/patrol/cases?tab=cases', 'cases incidents reports', feature('view_cases')],
  ['patrol', 'Case review', '#/patrol/cases?tab=review', 'review approve review group', (w) => w.manager || Boolean(w.patrol && (w.patrol.is_reviewer || w.patrol.can_manage_review))],
  ['patrol', 'Follow-up', '#/patrol/cases?tab=followup', 'follow up email', feature('followups')],
  ['patrol', 'Records requests', '#/patrol/cases?tab=records', 'records request release legal hold', feature('records')],
  ['patrol', 'Statistics', '#/patrol/cases?tab=stats', 'stats numbers', feature('reports')],
  ['patrol', 'Injury network', '#/patrol/cases?tab=network', 'nsaa network', feature('reports')],
  ['patrol', 'Risk report', '#/patrol/cases?tab=risk', 'insurance risk', feature('reports')],
  ['patrol', 'Access log', '#/patrol/cases?tab=access', 'who opened patient records audit', feature('view_access_log')],
  ['patrol', 'Schedule', '#/patrol/people?tab=schedule', 'patrol schedule shifts'],
  ['patrol', 'Crews', '#/patrol/people?tab=crews', 'crews teams'],
  ['patrol', 'Shift cover', '#/patrol/people?tab=cover', 'cover swap'],
  ['patrol', 'Today\'s posts', '#/patrol/people?tab=posts', 'posts assignments today'],
  ['patrol', 'Roster', '#/patrol/people?tab=team', 'roster patrollers team'],
  ['patrol', 'Training', '#/patrol/people?tab=training', 'training drills'],
  ['patrol', 'Skills', '#/patrol/people?tab=passport', 'skills passport'],
  ['patrol', 'Kits', '#/patrol/gear?tab=kits', 'kits bags'],
  ['patrol', 'Equipment', '#/patrol/gear?tab=equipment', 'equipment toboggan'],
  ['patrol', 'Medications', '#/patrol/gear?tab=meds', 'meds oxygen aed'],
  ['patrol', 'Lift evacuation', '#/patrol/gear?tab=lifts', 'lift evac evacuation rope'],
  ['patrol', 'Places and signs', '#/patrol/gear?tab=places', 'map mountain mark spot sign code qr help signs towers junctions print stencil', feature('map_places')],
  // Lessons
  ['school', 'My day', '#/school?tab=day&view=myday', 'my lessons instructor today', (w) => w.role === 'instructor' || w.manager],
  ['school', 'Lesson board', '#/school?tab=day&view=today', 'board who teaches'],
  ['school', 'Check-in', '#/school?tab=day&view=checkin', 'check in students arrive'],
  ['school', 'Lineup', '#/school?tab=day&view=lineup', 'lineup split groups'],
  ['school', 'All lessons', '#/school?tab=bookings&view=lessons', 'lessons sessions bookings'],
  ['school', 'Online requests', '#/school?tab=bookings&view=requests', 'requests online booking', (w) => w.manager || w.role === 'counter' || school('supervisor')(w)],
  ['school', 'Waitlist', '#/school?tab=bookings&view=waitlist', 'waitlist full'],
  ['school', 'Recaps', '#/school?tab=team&view=recaps', 'recaps after lesson'],
  ['school', 'Shift offers', '#/school?tab=team&view=offers', 'shift offers extra'],
  ['school', 'Who teaches what', '#/school?tab=team&view=instructors', 'instructors cleared', school('director')],
  ['school', 'Instructor availability', '#/school?tab=team&view=availability', 'availability open dates everyone', (w) => w.role !== 'instructor'],
  ['school', 'Payroll', '#/school?tab=team&view=payroll', 'payroll pay', school('director')],
  ['school', 'Instructor hours', '#/school?tab=team&view=hours', 'hours', school('director')],
  ['school', 'Season plan', '#/school?tab=plan&view=season', 'season plan publish', school('director')],
  ['school', 'Weather', '#/school?tab=plan&view=weather', 'weather delay cancel', school('director')],
  ['school', 'Staffing', '#/school?tab=plan&view=staffing', 'staffing enough instructors', school('director')],
  ['school', 'Reports', '#/school?tab=plan&view=reports', 'lessons reports', school('director')],
  // Sell, gate, shop, rentals, waivers
  ['sell', 'Partner passes', '#/sell?tab=partners', 'partner indy pass'],
  ['sell', 'Gift cards', '#/sell?tab=gift', 'gift card'],
  ['gate', 'Cards', '#/gate?tab=cards', 'rfid card'],
  ['shop', 'Will-call', '#/shop?tab=willcall', 'will call pickup online orders'],
  ['shop', 'Group inquiries', '#/shop?tab=groups', 'groups'],
  ['shop', 'Waitlist', '#/shop?tab=waitlist', 'waitlist sold out'],
  ['shop', 'Sales pace', '#/shop?tab=pace', 'pace sales', mgr],
  ['rentals', 'Returns', '#/rentals?tab=returns', 'check in return'],
  ['rentals', 'Out now', '#/rentals?tab=out', 'out overdue'],
  ['rentals', 'Rental groups', '#/rentals?tab=groups', 'groups school club'],
  ['rentals', 'Reservations', '#/rentals?tab=reservations', 'reserve'],
  ['rentals', 'Inventory', '#/rentals?tab=inventory', 'gear inventory tags', counter],
  ['rentals', 'Service', '#/rentals?tab=service', 'tune repair', counter],
  ['waivers', 'Sign a guest', '#/waivers?tab=sign', 'sign waiver'],
  // Back office
  ['money', 'Cash drawers', '#/money?tab=drawers', 'drawer till'],
  ['money', 'Weekly report', '#/money?tab=weekly', 'weekly'],
  ['money', 'Card statement', '#/money?tab=cards', 'stripe statement'],
  ['money', 'Sales tax', '#/money?tab=tax', 'tax'],
  ['money', 'Forecast data', '#/money?tab=forecast', 'forecast snapshots presales wind weather history'],
  ['workforce', 'Hours', '#/workforce?tab=hours', 'hours timecards approve'],
  ['workforce', 'Export for payroll', '#/workforce?tab=hours', 'payroll export pay hours timecards spreadsheet csv', mgr],
  ['workforce', 'On call', '#/workforce?tab=oncall', 'on call oncall on-call after hours rotation swap holiday callout call-out who is on call', (w) => w.muni && w.manager], // 2026.11.20
  ['workforce', 'Overtime', '#/workforce?tab=overtime', 'overtime over 40 hours week callouts call-outs ot', (w) => w.muni && w.manager],
  // The municipal edition's apps (2026.11.20)
  // Trash and recycling (2026.11.22): the app's tabs; the add-ons' tabs (routes, carts, tonnage, the report) add theirs.
  ['bulk', 'Collection calendar', '#/bulk?tab=calendar', 'trash recycling collection calendar schedule day zone what day is my pickup address lookup'],
  ['bulk', 'Missed pickups', '#/bulk?tab=missed', 'missed pickup trash recycling not picked up complaint'],
  ['bulk', 'Collection schedule setup', '#/bulk?tab=schedule', 'schedule setup zones streams streets holidays trash recycling yard waste', mgr],
  ['bulk', 'Holidays and moved days', '#/bulk?tab=schedule&part=days', 'holiday snow day weather moved canceled leaf collection christmas trees hazardous', mgr],
  ['bulk', 'Act 101 education log', '#/bulk?tab=schedule&part=residents', 'act 101 education reminder mailer print recycling report reminders sign-ups', mgr],
  ['bulk', 'Bulk pickup bookings', '#/bulk?tab=bookings', 'bulk pickup bookings furniture'],
  ['bulk', 'Cart requests', '#/bulk?tab=carts', 'cart can bin toter new extra replacement stolen request delivery'],
  ['bulk', 'Cart deliveries', '#/bulk?tab=carts&part=stops', 'cart delivery deliver crew load'],
  ['bulk', 'Carts in the yard', '#/bulk?tab=carts&part=stock', 'cart stock yard inventory receive scrap count'],
  ['bulk', 'Cart sizes and fees', '#/bulk?tab=carts&part=setup', 'cart sizes gallons fee extra replacement', mgr],
  ['bulk', 'Tonnage', '#/bulk?tab=tonnage', 'tonnage tons landfill recycling rate pounds per household cost per ton', counter],
  ['bulk', 'Weigh tickets', '#/bulk?tab=tonnage&part=tickets', 'weigh ticket scale landfill transfer station gross tare net', counter],
  ['bulk', 'Bring in a tonnage report', '#/bulk?tab=tonnage&part=import', 'import spreadsheet csv hauler facility monthly statement tonnage', counter],
  ['bulk', 'Recycling report (Act 101)', '#/bulk?tab=recycling', 'act 101 recycling report county dep hauler business fm-11 fm-12 fm-13 section 904 grant', mgr],
  ['requests', 'Ledger (repair record)', '#/requests?tab=ledger', 'ledger repair record right to know claim response standard met target'],
  ['requests', 'Requests map', '#/requests?tab=map', 'map where'],
  ['requests', 'Done requests', '#/requests?tab=done', 'fixed closed finished'],
  ['requests', 'Request settings', '#/requests?tab=settings', 'categories response standards street classes after hours', mgr],
  ['works', 'Done work orders', '#/works?tab=done', 'closed finished completed'],
  ['works', 'Service plans', '#/works?tab=plans', 'preventive maintenance service plan oil change'],
  ['assets', 'Asset map', '#/assets?tab=map', 'map water sewer stormwater valve hydrant manhole main outfall gis'],
  ['assets', 'Parts', '#/assets?tab=parts', 'parts stock inventory'],
  ['assets', 'Asset costs', '#/assets?tab=costs', 'costs spending', mgr],
  ['workforce', 'Staff list', '#/workforce?tab=staff', 'staff people employees'],
  ['catalog', 'Guest types', '#/catalog?tab=types', 'guest types ages'],
  ['catalog', 'Promo codes', '#/catalog?tab=promos', 'promo discount code'],
  ['messages', 'Automatic reminders', '#/messages?tab=auto', 'automatic reminders', (w) => !w.muni], // a ski area's rental and pass reminders
];

/**
 * The pages inside apps this person may open. views: the app keys they may open; who: { manager, role, school, patrol }.
 * Returns [{ app, title, href, words }].
 */
export function subPagesFor(views, who) {
  const open = new Set(views);
  return SUB_PAGES.filter(([app, , , , may]) => open.has(app) && (!may || may(who)))
    .map(([app, title, href, words]) => ({ app, title, href, words }));
}
