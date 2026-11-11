-- Plugin icons: one small PNG, JPEG or WebP per plugin, uploaded by the platform administrator and
-- served publicly at /v1/icons/{pluginId}. The catalog points the desktop market at it (media.icon),
-- the same field upstream catalogs use, and the docs center shows it beside the plugin.
CREATE TABLE IF NOT EXISTS market_plugin_icons (
  plugin_id TEXT PRIMARY KEY REFERENCES market_plugins(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp')),
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
