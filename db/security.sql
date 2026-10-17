-- Security hardening (2026.10.16).
-- Each sign-in is a session the server can end: signing out, an hour without use, a password change, or the console.
-- The id is kept only as a hash, so the table cannot be used to sign in.
CREATE TABLE IF NOT EXISTS user_sessions (
  id_hash     CHAR(64) NOT NULL PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL,
  last_seen   DATETIME NOT NULL,
  expires_at  DATETIME NOT NULL,
  ended_at    DATETIME NULL,
  ended_why   VARCHAR(30) NULL,
  ip_hash     CHAR(64) NULL,
  agent       VARCHAR(120) NULL,
  KEY ix_sessions_user (user_id, ended_at),
  KEY ix_sessions_expire (expires_at)
) ENGINE=InnoDB;
