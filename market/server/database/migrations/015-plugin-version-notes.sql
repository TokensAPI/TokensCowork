-- What changed in each version of a plugin, in Chinese and in English (T0113). Two sources per
-- language: the text taken automatically from the CHANGELOG in that version's package (auto_*), and
-- the text a platform administrator wrote (admin_*). Readers get the administrator's text where there
-- is one, the automatic text otherwise (services/plugin-notes.js).
--
-- A row is written the first time a version is read from its package (extracted_at; null = not read
-- yet, or the read failed and will be tried again) or edited. `package` names the package the
-- automatic text came from, so a plugin pointed at another package reads its versions afresh.
-- Versions never change once published, so a row read from the package is not read again.
CREATE TABLE IF NOT EXISTS market_plugin_notes (
  plugin_id TEXT NOT NULL REFERENCES market_plugins(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  published_at TEXT,
  package TEXT,
  auto_zh TEXT,
  auto_en TEXT,
  extracted_at INTEGER,
  admin_zh TEXT,
  admin_en TEXT,
  updated_at INTEGER,
  PRIMARY KEY(plugin_id, version)
);
