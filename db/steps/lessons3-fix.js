'use strict';
// Lesson planning, best of breed (2026.11.9), review fixes: a booking page search that found a lesson full is noted once
// per visitor (a hash of the address and the day, never the address itself) per lesson per day. Loaded by db/migrate.js.
module.exports = ({ columnExists }) => [
  ['lesson_full_searches.visitor_sha', (c) => columnExists(c, 'lesson_full_searches', 'visitor_sha'),
    'ALTER TABLE lesson_full_searches ADD COLUMN visitor_sha CHAR(64) NULL, ADD KEY ix_lesson_full_searches_visitor (tenant_id, session_id, visitor_sha)'],
];
