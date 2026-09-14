/** Shared scope registry: resolve each package independently, retain its ACL. */
export function patchRegistryRoutes(source) {
  if (source.includes("  if (id === 'by-package') {")) return source
  const anchor = '  const id = parts.shift()';
  if (source.split(anchor).length !== 2) throw new Error('Registry route anchor changed');
  return source.replace(anchor, `  let id = parts.shift()
  if (id === 'by-package') {
    // Metadata requests only. Returned tarball URLs retain the real plugin ID.
    const name = parts.join('/')
    if (!packageOK(name)) return reply({ error: 'Invalid package name' }, 400)
    const { results } = await env.MARKET_DB.prepare("SELECT p.id FROM market_plugins p JOIN market_catalog c ON c.id=p.id WHERE c.state='published' AND json_extract(p.metadata,'$.package')=? LIMIT 2").bind(name).all()
    if (results.length !== 1) return reply({ error: '插件不存在或没有下载权限' }, 403)
    id = results[0].id
    // metadataResponse performs the original per-plugin authorization check.
    return metadataResponse(request, env, id, name)
  }`);
}

export function patchInstallerRouting(source) {
  const oldRegistry = 'const registry = `${this.registryOrigin}/registry/${encodeURIComponent(candidate.itemId)}/`';
  const oldAuth = 'const auth = `--//${new URL(registry).host}/registry/${encodeURIComponent(candidate.itemId)}/:_authToken=${token}`';
  if (source.split(oldRegistry).length !== 2 || source.split(oldAuth).length !== 2) throw new Error('Installer routing anchor changed');
  return source.replace(oldRegistry, 'const registry = `${this.registryOrigin}/registry/by-package/`')
    .replace(oldAuth, 'const auth = `--//${new URL(registry).host}/registry/:_authToken=${token}`');
}
