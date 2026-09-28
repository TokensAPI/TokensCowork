-- Collapse the schema to what the market actually does: plugins, who may see them, and the
-- TokensAPI organizations that narrow that. Runs exactly once (database/migrate.mjs records it),
-- inside one transaction, against a database at 006 — or one that ran the unreleased
-- multi-tenant draft, whose tables are declared as empty shells below so both shapes converge.

CREATE TABLE IF NOT EXISTS market_tenant_plugins (organization_id INTEGER, plugin_id TEXT, enabled INTEGER, revision INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS market_admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, target TEXT, details TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS market_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  organization_id INTEGER,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS market_audit_events_created ON market_audit_events(created_at);
INSERT INTO market_audit_events(actor_kind,actor_id,organization_id,action,target,details,created_at)
 SELECT 'legacy','',NULL,action,target,details,created_at FROM market_admin_audit;

-- One row per plugin: directory metadata and lifecycle together, one revision guarding both.
-- A plugin that never had a catalog row predates the managed catalog and was never served, so it
-- lands as a draft rather than disappearing.
CREATE TABLE market_plugins_next (
  id TEXT PRIMARY KEY,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','restricted')),
  state TEXT NOT NULL CHECK(state IN ('draft','published','archived','deleted')),
  metadata TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  version_mode TEXT NOT NULL DEFAULT 'latest' CHECK(version_mode IN ('pinned','latest')),
  license_reference TEXT NOT NULL DEFAULT '',
  reviewed_version TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO market_plugins_next(id,visibility,state,metadata,revision,version_mode,license_reference,reviewed_version,updated_at)
 SELECT p.id,p.visibility,COALESCE(c.state,'draft'),p.metadata,COALESCE(c.revision,1),COALESCE(c.version_mode,'latest'),
  COALESCE(c.license_reference,''),COALESCE(c.reviewed_version,''),COALESCE(c.updated_at,0)
 FROM market_plugins p LEFT JOIN market_catalog c ON c.id=p.id;

-- The Key directory. The raw value is sealed with AES-GCM whose associated data names the context
-- it was sealed in; values written before this migration were sealed per plugin or per subject,
-- so the context travels with the ciphertext instead of forcing a re-encryption here.
CREATE TABLE market_keys_next (
  fingerprint TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  encrypted_value TEXT,
  sealed_for TEXT NOT NULL DEFAULT 'key',
  created_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO market_keys_next(fingerprint,label) SELECT fingerprint,label FROM market_keys;
INSERT INTO market_keys_next(fingerprint,label) SELECT id,label FROM market_access_subjects WHERE kind='key'
 ON CONFLICT(fingerprint) DO UPDATE SET label=CASE WHEN market_keys_next.label='' THEN excluded.label ELSE market_keys_next.label END;
-- Every fingerprint that holds a grant gets a directory row, so a grant is never orphaned.
INSERT INTO market_keys_next(fingerprint) SELECT DISTINCT fingerprint FROM market_plugin_key_grants WHERE true
 ON CONFLICT(fingerprint) DO NOTHING;
UPDATE market_keys_next SET encrypted_value=v.encrypted_value, sealed_for=v.plugin_id
 FROM (SELECT fingerprint,MIN(plugin_id) AS plugin_id FROM market_plugin_key_values GROUP BY fingerprint) AS pick
 JOIN market_plugin_key_values v ON v.fingerprint=pick.fingerprint AND v.plugin_id=pick.plugin_id
 WHERE market_keys_next.fingerprint=pick.fingerprint;
UPDATE market_keys_next SET encrypted_value=s.encrypted_value, sealed_for='subject'
 FROM market_access_subjects s WHERE s.kind='key' AND s.id=market_keys_next.fingerprint AND s.encrypted_value IS NOT NULL;

-- Grants: a plugin is offered to an organization or to a single Key. Only restricted plugins
-- consult them; a public plugin keeps its grants so switching back to restricted restores them.
CREATE TABLE market_grants_next (
  plugin_id TEXT NOT NULL REFERENCES market_plugins_next(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('org','key')),
  subject TEXT NOT NULL,
  PRIMARY KEY(plugin_id, kind, subject)
);
INSERT INTO market_grants_next(plugin_id,kind,subject)
 SELECT plugin_id,'org',CAST(organization_id AS TEXT) FROM market_org_grants WHERE plugin_id IN (SELECT id FROM market_plugins_next);
INSERT INTO market_grants_next(plugin_id,kind,subject)
 SELECT plugin_id,'key',fingerprint FROM market_plugin_key_grants WHERE plugin_id IN (SELECT id FROM market_plugins_next);

-- An organization administrator's switch: a row hides a plugin the platform granted to that
-- organization. It can only narrow, never widen.
CREATE TABLE market_org_hidden (
  organization_id INTEGER NOT NULL REFERENCES market_organizations(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES market_plugins_next(id) ON DELETE CASCADE,
  PRIMARY KEY(organization_id, plugin_id)
);
INSERT INTO market_org_hidden(organization_id,plugin_id)
 SELECT organization_id,plugin_id FROM market_tenant_plugins WHERE enabled=0
  AND organization_id IN (SELECT id FROM market_organizations) AND plugin_id IN (SELECT id FROM market_plugins_next);

-- One session table for both kinds of console user: organization_id is NULL for the platform
-- administrator, otherwise the organization a TokensAPI administrator manages. Old sessions are
-- not carried over; everyone signs in once more.
CREATE TABLE market_sessions (
  token_hash TEXT PRIMARY KEY,
  organization_id INTEGER,
  user_id INTEGER,
  expires_at INTEGER NOT NULL,
  credential_version TEXT NOT NULL
);
CREATE INDEX market_sessions_expiry ON market_sessions(expires_at);

CREATE TABLE market_login_limits (
  bucket_hash TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL CHECK(failure_count > 0),
  expires_at INTEGER NOT NULL
);
CREATE INDEX market_login_limits_expiry ON market_login_limits(expires_at);

-- Children before parents, so no foreign key ever points at a dropped table.
DROP TABLE IF EXISTS market_tenant_plugins;
DROP TABLE IF EXISTS market_tenant_sessions;
DROP TABLE IF EXISTS market_service_clients;
DROP TABLE IF EXISTS market_plugin_key_grants;
DROP TABLE IF EXISTS market_org_grants;
DROP TABLE IF EXISTS market_org_policies;
DROP TABLE IF EXISTS market_plugin_key_values;
DROP TABLE IF EXISTS market_access_subjects;
DROP TABLE IF EXISTS market_grants;
DROP TABLE IF EXISTS market_catalog;
DROP TABLE IF EXISTS market_admin_sessions;
DROP TABLE IF EXISTS market_admin_login_limits;
DROP TABLE IF EXISTS market_admin_audit;
DROP TABLE market_keys;
DROP TABLE market_plugins;
ALTER TABLE market_plugins_next RENAME TO market_plugins;
ALTER TABLE market_keys_next RENAME TO market_keys;
ALTER TABLE market_grants_next RENAME TO market_grants;

CREATE TRIGGER market_plugin_revision BEFORE UPDATE ON market_plugins
 WHEN NEW.revision != OLD.revision + 1
 BEGIN SELECT RAISE(ABORT,'plugin revision conflict'); END;
