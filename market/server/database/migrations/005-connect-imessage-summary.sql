-- Refresh the Connection Center summary after the iMessage channel shipped (dsh-connect v2.7.0).
UPDATE market_plugins SET metadata=json_set(metadata,'$.summary','统一管理十种 IM 机器人及飞书、钉钉个人账号授权，并接入本机 TokensCowork。')
 WHERE id='tokens-connect' AND NOT EXISTS(SELECT 1 FROM market_data_migrations WHERE id='005');
INSERT INTO market_data_migrations(id) VALUES('005') ON CONFLICT(id) DO NOTHING;
