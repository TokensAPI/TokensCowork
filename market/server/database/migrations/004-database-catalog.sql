-- One-time conversion of the former release roster. Do not edit this seed for new plugins.
CREATE TABLE IF NOT EXISTS market_data_migrations(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS market_catalog(
 id TEXT PRIMARY KEY REFERENCES market_plugins(id),
 state TEXT NOT NULL CHECK(state IN ('draft','published','archived','deleted')),
 revision INTEGER NOT NULL DEFAULT 1,
 version_mode TEXT NOT NULL DEFAULT 'pinned' CHECK(version_mode IN ('pinned','latest')),
 license_reference TEXT NOT NULL DEFAULT '',
 reviewed_version TEXT NOT NULL DEFAULT '',
 updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS market_catalog_revision BEFORE UPDATE ON market_catalog
 WHEN NEW.revision != OLD.revision + 1
 BEGIN SELECT RAISE(ABORT,'catalog revision conflict'); END;
INSERT INTO market_plugins(id,visibility,metadata) SELECT 'tokens-connect','public','{"id":"tokens-connect","category":"optional","package":"@tokensapi/dsh-connect","displayName":"连接中心","summary":"统一管理九种 IM 机器人及飞书、钉钉个人账号授权，并接入本机 TokensCowork。","repository":"https://github.com/sobermh/tokens_DshConnect_code","version":"2.6.1","npm":true}' WHERE NOT EXISTS(SELECT 1 FROM market_data_migrations WHERE id='004') ON CONFLICT(id) DO NOTHING;
INSERT INTO market_plugins(id,visibility,metadata) SELECT 'tokens-progressive-tools','public','{"id":"tokens-progressive-tools","category":"optional","package":"@tokensapi/dsh-progressive-tools","displayName":"渐进式工具","summary":"只让高频工具常驻模型上下文，其余工具按需搜索并通过原有 DSH 安全执行链分发。","repository":"https://github.com/TokensAPI/tokens_DshProgressiveTools_code","version":"0.1.0","npm":true}' WHERE NOT EXISTS(SELECT 1 FROM market_data_migrations WHERE id='004') ON CONFLICT(id) DO NOTHING;
INSERT INTO market_plugins(id,visibility,metadata) SELECT 'tokens-browser-use','public','{"id":"tokens-browser-use","category":"optional","package":"@tokensapi/dsh-browser-use","displayName":"浏览器操作","summary":"桥接 Playwright MCP，让模型驱动可见浏览器完成网页操作，带可视光标与坐标模式。","repository":"https://github.com/TokensAPI/tokens_DshBrowserUse_code","version":"0.1.0","npm":true}' WHERE NOT EXISTS(SELECT 1 FROM market_data_migrations WHERE id='004') ON CONFLICT(id) DO NOTHING;
INSERT INTO market_plugins(id,visibility,metadata) SELECT 'tokens-media-gen','public','{"id":"tokens-media-gen","category":"optional","package":"@tokensapi/dsh-media-gen","displayName":"媒体生成","summary":"接入 TokensAPI 图像与视频生成能力，让模型在会话中按上下文生成图片和视频。","repository":"https://github.com/TokensAPI/tokens_DshMediaGen_code","version":"0.3.0","npm":true}' WHERE NOT EXISTS(SELECT 1 FROM market_data_migrations WHERE id='004') ON CONFLICT(id) DO NOTHING;
INSERT INTO market_catalog(id,state,version_mode,license_reference,reviewed_version)
 SELECT id,'published',CASE WHEN json_extract(metadata,'$.npm')=1 THEN 'latest' ELSE 'pinned' END,
 'legacy-migration',COALESCE(json_extract(metadata,'$.version'),'')
 FROM market_plugins WHERE id NOT IN ('tokens-version-updates','dsh-tokensapi-ui','tokens-model-manager','tokens-dsh-web-search') AND COALESCE(json_extract(metadata,'$.category'),'optional') != 'builtin'
 AND NOT EXISTS(SELECT 1 FROM market_data_migrations WHERE id='004')
 ON CONFLICT(id) DO NOTHING;
INSERT INTO market_data_migrations(id) VALUES('004') ON CONFLICT(id) DO NOTHING;

