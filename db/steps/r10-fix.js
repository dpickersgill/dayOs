'use strict';
// 2026.11.10 fixes after review. Loaded by db/migrate.js. Additive and safe to run twice.
//   user_sessions.back_at    when a page of the app last opened with this session (POST /auth/back)
//   user_sessions.back_page  that page's own open time (the browser's clock, in ms). A closing notice that arrives within
//                            seconds after a back notice and comes from an OLDER page is the reload race (the new page
//                            spoke first), so it is ignored. One from the same page is a real close.
module.exports = ({ columnExists }) => [
  ['user_sessions.back_at', (c) => columnExists(c, 'user_sessions', 'back_at'), 'ALTER TABLE user_sessions ADD COLUMN back_at DATETIME NULL'],
  ['user_sessions.back_page', (c) => columnExists(c, 'user_sessions', 'back_page'), 'ALTER TABLE user_sessions ADD COLUMN back_page BIGINT NULL'],
];
