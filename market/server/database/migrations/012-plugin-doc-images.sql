-- Images for plugin documentation pages, uploaded by the platform administrator. Unlike icons they
-- are never public: readers fetch them at /v1/docs/{pluginId}/images/{id} under the same access
-- decision as the plugin's pages. The id is random and an image never changes once stored, so a
-- reader may keep it in a private cache; the same bytes uploaded again for the same plugin are
-- found by their SHA-256 and answered with the image already stored.
CREATE TABLE IF NOT EXISTS market_plugin_doc_images (
  id TEXT PRIMARY KEY CHECK(length(id) = 32),
  plugin_id TEXT NOT NULL REFERENCES market_plugins(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp')),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS market_plugin_doc_images_plugin ON market_plugin_doc_images(plugin_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS market_plugin_doc_images_content ON market_plugin_doc_images(plugin_id, sha256);
