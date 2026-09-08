CREATE TABLE IF NOT EXISTS market_keys (
  fingerprint TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS market_grants (
  fingerprint TEXT NOT NULL REFERENCES market_keys(fingerprint),
  plugin_id TEXT NOT NULL,
  PRIMARY KEY(fingerprint, plugin_id)
);
CREATE TABLE IF NOT EXISTS market_plugins (
  id TEXT PRIMARY KEY,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','restricted')),
  metadata TEXT NOT NULL,
  object_key TEXT
);
