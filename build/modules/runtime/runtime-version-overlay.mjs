import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

/** Keep upstream peer contracts exact after the product repins the runtime. */
export function alignRuntimePeerAssertions(source, upstreamPeers, version) {
  let matched = 0
  const result = source.replace(
    /expect\(manifest\.peerDependencies\)\.toHaveProperty\('(@deepseek-ai\/dsh[^']*)', '([^']+)'\)/gu,
    (assertion, name, expected) => {
      if (!isDshPackage(name)) return assertion
      if (upstreamPeers[name] !== expected && expected !== version) {
        throw new Error(`Runtime peer contract drift: ${name} expects ${expected}`)
      }
      matched++
      return `expect(manifest.peerDependencies).toHaveProperty('${name}', '${version}')`
    },
  )
  if (!matched) throw new Error('Runtime peer contract assertions are missing')
  return result
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

/** Pinned web-search client predates DSH's lazy command-description contract. */
export function alignWebSearchCommandDescription(source) {
  const old = 'description: "切换搜索引擎 / Switch web search engine",'
  const current = 'description: () => "切换搜索引擎 / Switch web search engine",'
  const registration = /command\.register\(\{\s*name: "tokens-dsh-web-search",/g
  if ([...source.matchAll(registration)].length !== 1) {
    throw new Error('Web-search command registration changed; review plugin compatibility')
  }
  const oldCount = source.split(old).length - 1
  const currentCount = source.split(current).length - 1
  if (oldCount === 0 && currentCount === 1) return source
  if (oldCount !== 1 || currentCount !== 0) {
    throw new Error('Web-search command description changed; review plugin compatibility')
  }
  return source.replace(old, current)
}

export function prepareRuntimeVersion(stage, version) {
  const path = resolve(stage, 'package.json')
  const workspace = JSON.parse(readFileSync(path, 'utf8'))
  workspace.resolutions = alignRuntimeResolutions(workspace.resolutions, version)
  writeFileSync(path, `${JSON.stringify(workspace, null, 2)}\n`)
  // The user explicitly chose this release. Approve only its exact packages,
  // retaining Yarn's age gate for every unrelated/newer registry release.
  const approved = [...new Set(Object.keys(workspace.resolutions)
    .filter(selector => selector.startsWith('@deepseek-ai/dsh'))
    .map(selector => `${selector.split('@npm:')[0]}@${version}`))]
  const yarnConfigPath = resolve(stage, '.yarnrc.yml')
  const yarnConfig = readFileSync(yarnConfigPath, 'utf8')
  if (!yarnConfig.includes('npmPreapprovedPackages:')) throw new Error('Missing Yarn approval list')
  writeFileSync(yarnConfigPath, yarnConfig.replace('npmPreapprovedPackages:',
    `npmPreapprovedPackages:\n${approved.map(name => `  - ${JSON.stringify(name)}`).join('\n')}`))
  for (const entry of workspace.workspaces) {
    if (entry.includes('*')) throw new Error(`Unexpected upstream workspace glob: ${entry}`)
    const packagePath = resolve(stage, entry, 'package.json')
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
    if (entry === 'dsh-community-market') {
      const contractsPath = resolve(stage, entry, 'tests', 'contracts.spec.ts')
      writeFileSync(contractsPath, alignRuntimePeerAssertions(
        readFileSync(contractsPath, 'utf8'), pkg.peerDependencies ?? {}, version,
      ))
    }
    alignRuntimeDependencies(pkg, version)
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  for (const name of ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta']) {
    const testPath = resolve(stage, name, 'tests', 'package.spec.ts')
    const source = readFileSync(testPath, 'utf8')
      .replace(/const runtimeVersion = '[^']+'/u, `const runtimeVersion = '${version}'`)
      .replaceAll('0\\.1\\.5-rc\\.1', version.replaceAll('.', '\\.'))
    writeFileSync(testPath, source)
  }
}
