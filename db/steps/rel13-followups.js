'use strict';
// Release 2026.11.13 follow-ups. Loaded by db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB, and
// on a 2026.11.12 database.
//   lesson_bookings.ladder_ticket_id    the lift ticket a learn to ski ladder lesson issued at check-in (once per lesson)
//   lesson_bookings.ladder_contract_id  the rental contract (to fit) the same check-in opened
module.exports = ({ columnExists }) => [
  ['lesson_bookings.ladder_ticket_id', (c) => columnExists(c, 'lesson_bookings', 'ladder_ticket_id'), 'ALTER TABLE lesson_bookings ADD COLUMN ladder_ticket_id BIGINT UNSIGNED NULL'],
  ['lesson_bookings.ladder_contract_id', (c) => columnExists(c, 'lesson_bookings', 'ladder_contract_id'), 'ALTER TABLE lesson_bookings ADD COLUMN ladder_contract_id BIGINT UNSIGNED NULL'],
];
