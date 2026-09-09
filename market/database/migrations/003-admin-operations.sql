-- Additive and idempotent. Never stores raw credentials or visitor IP addresses.
CREATE TABLE IF NOT EXISTS market_admin_login_limits (
  bucket_hash TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL CHECK(failure_count > 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS market_admin_login_limits_expiry
  ON market_admin_login_limits(expires_at);

CREATE TABLE IF NOT EXISTS market_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
