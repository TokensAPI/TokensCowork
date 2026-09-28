/** Explicit pre-existing catalog fixtures for ACL regression tests (never production). */
export function seedTestPlugin(db, metadata, state='published') {
  db.prepare("INSERT INTO market_plugins(id,visibility,state,metadata,version_mode,reviewed_version) VALUES(?,'public',?,?,'pinned',?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,revision=revision+1")
    .run(metadata.id,state,JSON.stringify(metadata),metadata.version)
}
export function resetTestCatalog(db, metadata) {
  db.exec('DELETE FROM market_plugins')
  seedTestPlugin(db,metadata)
}
