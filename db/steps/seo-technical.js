'use strict';
// SEO technical fixes (2026.11). Loaded by db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB, and
// on a 2026.11.13 database.
//   site_leads.source_page  the website page the visitor came from before the form ("/ski-patrol"; "/" for Home), so
//                           walkthrough requests can be counted by page. A page address, never anything about the person.
//   site_leads.source_ref   the other website that sent them to us, as its domain only ("google.com"), when there was one
module.exports = ({ columnExists }) => [
  ['site_leads.source_page', (c) => columnExists(c, 'site_leads', 'source_page'), 'ALTER TABLE site_leads ADD COLUMN source_page VARCHAR(200) NULL, ADD COLUMN source_ref VARCHAR(120) NULL'],
];
