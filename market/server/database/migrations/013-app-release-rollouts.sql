-- Staged rollout of desktop app versions. The desktop update plugin asks GET /v1/app/update which
-- version it is offered; the platform administrator decides per version who gets it (see
-- services/app-releases.js). The installers themselves stay on GitHub Releases.
--
-- One row per app version (stable x.y.z) the platform rolls out. draft: nobody is offered it;
-- rolling: the hold list, the early list, then `percent` of everyone else; paused: nobody; full:
-- everyone but the hold list (percent is 100).
CREATE TABLE IF NOT EXISTS app_release_rollouts (
  version TEXT PRIMARY KEY CHECK(length(version) BETWEEN 5 AND 20),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','rolling','paused','full')),
  percent INTEGER NOT NULL DEFAULT 0 CHECK(percent BETWEEN 0 AND 100),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
-- The organizations a version goes to first (early) or is held back from (hold). An organization
-- is on at most one of the two lists of a version.
CREATE TABLE IF NOT EXISTS app_release_rollout_orgs (
  version TEXT NOT NULL REFERENCES app_release_rollouts(version) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES market_organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('early','hold')),
  PRIMARY KEY(version, organization_id)
);
-- Each installation as its last update check described it: the random installation id the app
-- generates (no hardware data), its version and platform, the TokensAPI account its Key belongs to
-- (when signed in and resolvable), and the version it was last offered (null = none). Rows not seen
-- for 90 days are removed by the server's hourly job.
CREATE TABLE IF NOT EXISTS app_installations (
  installation_id TEXT PRIMARY KEY CHECK(length(installation_id) = 36),
  version TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  account_id INTEGER,
  offered_version TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_installations_seen ON app_installations(last_seen_at);
