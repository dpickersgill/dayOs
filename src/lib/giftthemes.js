'use strict';
// Gift experiences (Guests round 2): the themes a gift can have, and the clean one-line form of a name a buyer typed.
// The theme and the giver's name go into the email subject, so the theme is one of these and names are one short line
// with no control characters (2026.11.11).
const THEMES = ['First day on snow', 'A Saturday with Grandpa', 'A day on the mountain', 'Learn to ride'];
/** One line, no control characters, at most n characters. */
const oneLine = (s, n = 60) => String(s || '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); // \s covers the line and paragraph separators too
module.exports = { THEMES, oneLine };
