/** Explicit pre-existing catalog fixtures for ACL regression tests (never production). */
export function seedTestPlugin(db, metadata, state='published') {
  db.prepare('INSERT INTO market_plugins(id,visibility,metadata) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata').run(metadata.id,'public',JSON.stringify(metadata))
  db.prepare('INSERT INTO market_catalog(id,state,version_mode,reviewed_version) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').run(metadata.id,state,'pinned',metadata.version)
}
export function resetTestCatalog(db, metadata) {
  db.exec('DELETE FROM market_catalog; DELETE FROM market_plugins')
  seedTestPlugin(db,metadata)
}
