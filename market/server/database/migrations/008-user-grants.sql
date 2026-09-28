-- A plugin can also be granted to one TokensAPI user, independent of that user's organization
-- and Keys. The market does not copy TokensAPI's user table: it records only the users an
-- administrator granted something to, with a display name kept for the console.
CREATE TABLE market_users (
  id INTEGER PRIMARY KEY CHECK(id > 0),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE market_grants_next (
  plugin_id TEXT NOT NULL REFERENCES market_plugins(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('org','key','user')),
  subject TEXT NOT NULL,
  PRIMARY KEY(plugin_id, kind, subject)
);
INSERT INTO market_grants_next(plugin_id,kind,subject) SELECT plugin_id,kind,subject FROM market_grants;
DROP TABLE market_grants;
ALTER TABLE market_grants_next RENAME TO market_grants;
CREATE INDEX market_grants_subject ON market_grants(kind, subject);
