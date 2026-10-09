'use strict';

// Which days of the week a product is sold. Stored as a number: Sunday is 1, Monday 2, Tuesday 4 ... Saturday 64.
// Nothing saved (or all seven days) means every day.
const { weekdayOf } = require('./util');

const ALL = 127;
const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = 62; const WEEKEND = 65;

const allowedOn = (mask, day) => mask === null || mask === undefined || Number(mask) === ALL || (Number(mask) & (1 << weekdayOf(day))) !== 0;
const dayName = (day) => NAMES[weekdayOf(day)];
/** "Monday to Friday only", "weekends only", or a list of days. */
function daysText(mask) {
  const m = Number(mask);
  if (m === WEEKDAYS) return 'Monday to Friday only';
  if (m === WEEKEND) return 'Saturday and Sunday only';
  return `${SHORT.filter((_, i) => m & (1 << i)).join(', ')} only`;
}

module.exports = { ALL, WEEKDAYS, WEEKEND, allowedOn, dayName, daysText };
