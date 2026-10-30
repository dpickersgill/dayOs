'use strict';
// Lesson planning, best of breed (2026.11.9), Track STAFF: when a lesson fills (for the demand view), the "fill the gap"
// asks sent from the fill view, and the booking page searches that found a lesson full. Loaded by db/migrate.js.
module.exports = ({ tableExists, columnExists }) => [
  // full_at: the first time the lesson filled (kept). full_since: full right now since then (null when it has room).
  // reopened_at: the last time a full lesson had room again. Kept by the lessons job (routes/schoolstaff.js tick).
  ['lesson_sessions.full_at', (c) => columnExists(c, 'lesson_sessions', 'full_at'),
    'ALTER TABLE lesson_sessions ADD COLUMN full_at DATETIME NULL, ADD COLUMN full_since DATETIME NULL, ADD COLUMN reopened_at DATETIME NULL'],
  // "Short 3 instructors Sat 9:30 AM, kids ski": one row per tap on Fill the gap, tied to the shift offer it sent.
  ['lesson_fill_asks', (c) => tableExists(c, 'lesson_fill_asks'), `CREATE TABLE lesson_fill_asks (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    offer_id    BIGINT UNSIGNED NOT NULL,
    on_date     DATE NOT NULL,
    start_time  TIME NOT NULL,
    discipline  ENUM('ski','snowboard','telemark','adaptive') NOT NULL DEFAULT 'ski',
    band        ENUM('kids','adults','all') NOT NULL DEFAULT 'all',
    short_n     SMALLINT UNSIGNED NOT NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_lesson_fill_asks (tenant_id, on_date),
    CONSTRAINT fk_lesson_fill_asks_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // A guest looked for a lesson and found it full (lib/lessondemand.js noteFull, called by the booking page).
  ['lesson_full_searches', (c) => tableExists(c, 'lesson_full_searches'), `CREATE TABLE lesson_full_searches (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    session_id BIGINT UNSIGNED NOT NULL,
    noted_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_lesson_full_searches (tenant_id, session_id),
    CONSTRAINT fk_lesson_full_searches_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
];
