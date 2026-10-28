'use strict';
// Waiver copy links: the link's token is kept only as a SHA-256, so a copy of the database does not hand out working links.
// Rows signed before this kept the plain token; it is hashed here and then cleared. Loaded by db/migrate.js.
// Each entry: [name, (conn) => Promise<boolean> already done, ddl].
const has = async (conn, sql, params) => (await conn.query(sql, params))[0].length > 0;

module.exports = ({ columnExists }) => [
  ['waiver_signings.token_sha', (c) => columnExists(c, 'waiver_signings', 'token_sha'),
    'ALTER TABLE waiver_signings ADD COLUMN token_sha CHAR(64) NULL AFTER token, ADD UNIQUE KEY uq_waiver_signings_token_sha (token_sha)'],
  // The plain token may now be empty; the unique key allows any number of NULLs.
  ['waiver_signings.token nullable', (c) => has(c, "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'waiver_signings' AND column_name = 'token' AND is_nullable = 'YES'"),
    'ALTER TABLE waiver_signings MODIFY token CHAR(32) NULL'],
  // Hash the tokens of rows signed before this, then clear the plain copies.
  ['waiver_signings plain tokens hashed', async (c) => !(await has(c, 'SELECT 1 FROM waiver_signings WHERE token IS NOT NULL LIMIT 1')), [
    'UPDATE waiver_signings SET token_sha = SHA2(token, 256) WHERE token IS NOT NULL AND token_sha IS NULL',
    'UPDATE waiver_signings SET token = NULL WHERE token IS NOT NULL AND token_sha IS NOT NULL',
  ]],
];
