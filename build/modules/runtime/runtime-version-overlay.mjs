export const isDshPackage = name => /^@deepseek-ai\/dsh(?:$|-)/u.test(name)

/** Cordis shadows service getters with the provider scope. Acquire WebServer
 * explicitly while keeping registration/disposal owned by the calling fiber. */
export function alignConnectionRpcScope(source) {
  const before = 'return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);'
  const after = `// Unwrap the getter shadow exactly as Cordis getTraceable does.
    const caller = Object.hasOwn(owner, Symbol.for("cordis.shadow")) ? Object.getPrototypeOf(owner) : owner;
    return caller.effect(() => {
      const webScope = caller.inject(["webServer"], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register(route), "product: scoped RPC route");
      });
      return () => webScope.dispose();
    }, \`client-connection: \${channel} rpc channel\`);`
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error('Connection RPC scope anchor changed')
  return source.replace(before, after)
}

/** One runtime family for every product workspace, including plugin peers. */
export function alignRuntimeDependencies(manifest, version) {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (isDshPackage(name)) manifest[field][name] = version
    }
  }
  return manifest
}

/** Use exact published packages; retain Desktop's patches, frozen by the product lock. */
export function alignRuntimeResolutions(resolutions, version) {
  const result = {}
  for (const [selector, source] of Object.entries(resolutions)) {
    const name = selector.split('@npm:')[0]
    if (!isDshPackage(name)) { result[selector] = source; continue }
    if (!selector.includes('@npm:')) throw new Error(`Unsupported DSH selector: ${selector}`)
    const patch = source.startsWith('patch:') ? source.slice(source.indexOf('#')) : ''
    const target = patch ? `patch:${name}@npm%3A${version}${patch}` : `npm:${version}`
    result[`${name}@npm:${version}`] = target
    result[`${name}@npm:^${version}`] = target
  }
  return result
}

/** Preserve the old search namespace during upstream's one-time settings import. */
export function alignLegacySearchSettingsImport(source) {
  const anchor = 'const LEGACY_SECTION_ENTRIES = {'
  const mapping = '\n\t"free-search": "web-search-free",'
  if (source.includes(anchor + mapping)) return source
  if (source.split(anchor).length !== 2) throw new Error('Legacy settings import anchor changed')
  return source.replace(anchor, anchor + mapping)
}

/**
 * 把上游工作区统一到产品固定的 DSH 版本。
 * @param input.workspace - 根 package.json（对象）。
 * @param input.yarnConfig - .yarnrc.yml 文本。
 * @param input.manifests - { 工作区目录: package.json 对象 }。
 * @returns 同结构的结果；workspace 以外的 Yarn 冷却期只豁免产品固定版本。
 */
export function alignRuntimeVersion({ workspace, yarnConfig, manifests }, version) {
  workspace.resolutions = alignRuntimeResolutions(workspace.resolutions, version)
  // When upstream enables an age gate, approve the exact product runtime only.
  // Releases that explicitly disable the gate keep their upstream policy.
  const approved = [...new Set(Object.keys(workspace.resolutions)
    .filter(selector => selector.startsWith('@deepseek-ai/dsh'))
    .map(selector => `${selector.split('@npm:')[0]}@${version}`))]
  if (!yarnConfig.includes('npmPreapprovedPackages:') && !/npmMinimalAgeGate:\s*0/u.test(yarnConfig)) throw new Error('Missing Yarn approval list')
  yarnConfig = yarnConfig.replace('npmPreapprovedPackages:',
    `npmPreapprovedPackages:\n${approved.map(name => `  - ${JSON.stringify(name)}`).join('\n')}`)
  for (const manifest of Object.values(manifests)) alignRuntimeDependencies(manifest, version)
  return { workspace, yarnConfig, manifests }
}
