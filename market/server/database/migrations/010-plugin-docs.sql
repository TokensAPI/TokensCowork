-- Plugin documentation: Markdown pages a platform administrator attaches to a plugin. Readers see
-- the pages of exactly the plugins the catalog shows them; access is never stored here.
CREATE TABLE IF NOT EXISTS market_plugin_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL REFERENCES market_plugins(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS market_plugin_docs_plugin ON market_plugin_docs(plugin_id, position, id);
