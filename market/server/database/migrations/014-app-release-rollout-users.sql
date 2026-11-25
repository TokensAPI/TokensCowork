-- Staged rollout by user as well as by organization (T0112). The users a version goes to first
-- (early) or is held back from (hold), by TokensAPI user id. A user's setting comes before the
-- setting of the organization they belong to: user hold -> user early -> organization hold ->
-- organization early -> the percentage (services/app-releases.js).
--
-- A table of its own rather than a subject column on app_release_rollout_orgs: that table's key
-- and foreign key name an organization, and changing them in SQLite means rebuilding a live table.
-- A user need not be in the market's user directory (any TokensAPI user can be named), so there is
-- no foreign key to market_users. A user is on at most one of the two lists of a version.
CREATE TABLE IF NOT EXISTS app_release_rollout_users (
  version TEXT NOT NULL REFERENCES app_release_rollouts(version) ON DELETE CASCADE,
  user_id INTEGER NOT NULL CHECK(user_id > 0),
  kind TEXT NOT NULL CHECK(kind IN ('early','hold')),
  PRIMARY KEY(version, user_id)
);
CREATE INDEX IF NOT EXISTS app_release_rollout_users_user ON app_release_rollout_users(user_id);
