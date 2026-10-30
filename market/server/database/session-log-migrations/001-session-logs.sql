-- The session-log index. It lives in its own SQLite file (session-logs/index.sqlite), never in
-- market.sqlite, so it is backed up, cleaned and moved on its own. Raw batches stay in the
-- object store; these tables only point at them. No raw API Key is ever stored: key_fingerprint
-- is the same keyed HMAC the Key directory uses.
CREATE TABLE IF NOT EXISTS session_log_sessions (
  session_id TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  object_prefix TEXT NOT NULL,
  key_fingerprint TEXT,
  account_id TEXT,
  client_product TEXT,
  client_version TEXT,
  client_platform TEXT,
  cwd TEXT,
  parent_session TEXT,
  origin TEXT,
  title TEXT,
  created_at INTEGER,
  first_received_at INTEGER NOT NULL,
  last_received_at INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  max_seq INTEGER NOT NULL DEFAULT -1,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  models TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, format_version)
);
CREATE INDEX IF NOT EXISTS session_log_sessions_received ON session_log_sessions(last_received_at);
CREATE INDEX IF NOT EXISTS session_log_sessions_created ON session_log_sessions(created_at);
CREATE INDEX IF NOT EXISTS session_log_sessions_account ON session_log_sessions(account_id);
CREATE INDEX IF NOT EXISTS session_log_sessions_key ON session_log_sessions(key_fingerprint);

-- One row per stored event. The primary key is the deduplication rule of the upload contract.
CREATE TABLE IF NOT EXISTS session_log_events (
  session_id TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  time INTEGER,
  type TEXT NOT NULL,
  turn INTEGER,
  PRIMARY KEY (session_id, format_version, seq),
  FOREIGN KEY (session_id, format_version) REFERENCES session_log_sessions(session_id, format_version) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS session_log_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
