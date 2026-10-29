// The ski school, round 2 (pay). school.js adds these tabs to Ski school and these pages to Settings, Ski school.
// tabs(ctx): [[key, label, (panel) => render]], ctx = { staff, names, certs }. settingsPages: { key: { title, render(panel) } }.

export function tabs(_ctx) { return []; }

export const settingsPages = {};

/** A short pay line for a lesson on the instructor's My day ("Your pay: ..."), or null. */
export function payLine(_lesson) { return null; }

/** Anything the instructor must act on, shown at the top of My day (privates asked for by name, waiting to be accepted). */
export async function myDayTop(_panel) {}
