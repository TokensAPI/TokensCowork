-- Additive and idempotent. Existing restricted plugins remain on legacy policy until explicitly saved.
CREATE TABLE IF NOT EXISTS market_admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  credential_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_plugin_key_values (
  plugin_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  PRIMARY KEY(plugin_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS market_organizations (
  id INTEGER PRIMARY KEY CHECK(id > 0 AND id <= 9007199254740991),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
CREATE TABLE IF NOT EXISTS market_org_policies (
  plugin_id TEXT PRIMARY KEY REFERENCES market_plugins(id)
);
CREATE TABLE IF NOT EXISTS market_org_grants (
  plugin_id TEXT NOT NULL REFERENCES market_org_policies(plugin_id),
  organization_id INTEGER NOT NULL REFERENCES market_organizations(id),
  PRIMARY KEY(plugin_id, organization_id)
);
CREATE TABLE IF NOT EXISTS market_plugin_key_grants (
  plugin_id TEXT NOT NULL REFERENCES market_org_policies(plugin_id),
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(plugin_id, fingerprint)
);
