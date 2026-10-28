// Small helpers shared by the Staff and schedule screens. Shift times are the mountain's local wall-clock time as
// stored ('YYYY-MM-DD HH:MM:SS'), so they are read as text, never through the browser's clock.
import { addDays } from '../ui.js';

const asMs = (s) => Date.parse(`${String(s).replace(' ', 'T').slice(0, 19)}Z`);

/** '8 AM', '4:30 PM' */
export function hm(s) {
  const [H, M] = String(s).slice(11, 16).split(':').map(Number);
  const h12 = ((H + 11) % 12) + 1;
  return `${M ? `${h12}:${String(M).padStart(2, '0')}` : h12} ${H < 12 ? 'AM' : 'PM'}`;
}
/** '8 AM to 4:30 PM' (in sentences) and '8 AM–4:30 PM' (in a shift block) */
export const span = (a, b) => `${hm(a)} to ${hm(b)}`;
export const spanShort = (a, b) => `${hm(a)}–${hm(b)}`;
export const minutes = (a, b) => Math.round((asMs(b) - asMs(a)) / 60000);
/** '7h', '7h 30m' */
export const hrs = (m) => { const n = Math.max(0, Math.round(m)); const hh = Math.floor(n / 60); const mm = n % 60; return mm ? `${hh}h ${mm}m` : `${hh}h`; };

const fmt = (d, opts) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
export const dayShort = (d) => fmt(d, { weekday: 'short' });
export const monthDay = (d) => fmt(d, { month: 'short', day: 'numeric' });
export const dayLong = (d) => fmt(d, { weekday: 'long', month: 'long', day: 'numeric' });
export const weekLabel = (start) => `${monthDay(start)} to ${monthDay(addDays(start, 6))}`;
export const weekDays = (start) => Array.from({ length: 7 }, (_, i) => addDays(start, i));

export const DEPARTMENTS = ['lifts', 'rentals', 'ski_school', 'patrol', 'food', 'guest_services', 'grooming', 'maintenance', 'admin', 'attractions'];
export const STAFF_STATUS = ['active', 'onboarding', 'applicant', 'inactive'];
export const STATUS_TONE = { active: 'good', onboarding: 'neutral', applicant: 'neutral', inactive: 'warn' };
export const fullName = (s) => `${s.first_name} ${s.last_name}`;

/** '7:00 AM' from a 'HH:MM[:SS]' time of day. */
export const tod = (t) => hm(`2000-01-01 ${String(t).slice(0, 5)}`);
