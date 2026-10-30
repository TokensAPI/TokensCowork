-- Every Key a session was uploaded with. The console shows the Key itself, so it is kept here,
-- sealed with MARKET_KEY_ENCRYPTION_SECRET (AES-GCM, security/key-vault.js), never as plain
-- text. Without that secret encrypted_key stays NULL and only the fingerprint is known.
-- session_log_sessions.key_fingerprint remains the latest Key of the session.
CREATE TABLE IF NOT EXISTS session_log_keys (
  session_id TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  key_fingerprint TEXT NOT NULL,
  encrypted_key TEXT,
  first_used_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, format_version, key_fingerprint),
  FOREIGN KEY (session_id, format_version) REFERENCES session_log_sessions(session_id, format_version) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_log_keys_fingerprint ON session_log_keys(key_fingerprint, last_used_at);

-- Sessions stored before this table existed: their Key is known by fingerprint only.
INSERT OR IGNORE INTO session_log_keys(session_id, format_version, key_fingerprint, encrypted_key, first_used_at, last_used_at)
  SELECT session_id, format_version, key_fingerprint, NULL, first_received_at, last_received_at
  FROM session_log_sessions WHERE key_fingerprint IS NOT NULL;
