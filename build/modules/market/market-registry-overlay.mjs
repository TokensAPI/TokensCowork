/* ====================================================================
 * 私有 Registry（可选）
 * 目录与安装两侧都要认 tokenscowork 这个 registry 种类：契约、schema 和
 * 生成类型放宽，元数据校验走我们自己的受限 HTTP 客户端（带 Bearer），
 * 真正的下载交给官方插件管理器的 pnpm。
 *
 * Desktop v2.0.18 起 pnpm 的 argv 由官方插件管理器拼装，市场碰不到；
 * `scrubbedParentEnv()` 又会按 /KEY|PASSWORD|SECRET|TOKEN/i 把
 * `npm_config_…_authToken` 这类环境变量全部擦掉。剩下的唯一通道是 pnpm
 * 运行目录（也就是 Profile 目录）下的 `.npmrc`，所以本覆盖加入一个
 * 「一次操作写一次、finally 删掉」的临时 `.npmrc`：不持久化改写 Profile
 * 的包管理器配置，进程被杀留下的残留在服务启动时按产品标记清掉，
 * 用户自己的 `.npmrc` 一律不覆盖（遇到就让这次操作失败并提示）。
 * ==================================================================== */
import { replaceOnce } from '../../pipeline/anchors.mjs'

function widenRegistrySchema(source) {
  return replaceOnce(source, '"const": "npm"', '"enum": ["npm", "tokenscowork"]', 'provider package registry')
}

export function widenInstallCandidateRegistry(source) {
  return replaceOnce(source,
    "source === undefined && item.package?.registry === 'npm' && safePackageName(item.package.name)",
    "source === undefined && (item.package?.registry === 'npm' || item.package?.registry === 'tokenscowork') && safePackageName(item.package.name)",
    'installable candidate registry selection')
}

/** 目录契约、schema 与生成类型：放宽 registry 种类。 */
function widenContracts(files) {
  return {
    providerSchema: widenRegistrySchema(files.providerSchema),
    snapshotSchema: widenRegistrySchema(files.snapshotSchema),
    providerTypes: replaceOnce(files.providerTypes, "registry: 'npm'", "registry: 'npm' | 'tokenscowork'", 'provider package type'),
    snapshotTypes: replaceOnce(files.snapshotTypes, "registry: 'npm'", "registry: 'npm' | 'tokenscowork'", 'snapshot package type'),
    types: replaceOnce(files.types, "readonly registry: 'npm'", "readonly registry: 'npm' | 'tokenscowork'", 'normalized package type'),
    identity: replaceOnce(
      files.identity,
      "export function normalizePackageIdentity(packageIdentity: PackageIdentity): NormalizedPackageIdentity {\n  return { registry: 'npm', name: packageIdentity.name }\n}",
      "export function normalizePackageIdentity(packageIdentity: PackageIdentity): NormalizedPackageIdentity {\n  if (packageIdentity.registry !== 'npm' && packageIdentity.registry !== 'tokenscowork') {\n    throw new CatalogContractError('identity', [semanticIssue('/package/registry', 'must be npm or tokenscowork')])\n  }\n  return { registry: packageIdentity.registry, name: packageIdentity.name }\n}",
      'package identity normalization',
    ),
  }
}

/** 元数据校验器：公共 npm 走 latest，私有 Registry 走按插件授权的 packument。 */
const PRIVATE_VERIFIER = `/** Resolve public npm or the product private Registry and confirm the minimum DSH package shape. */
export function createNpmRegistryVerifier(http: CatalogHttpClient, options: { privateRegistryOrigin?: string } = {}): MarketNpmPackageVerifier {
  return {
    async verify(candidate, signal) {
      if (!safePackageName(candidate.packageName) || !marketManagedPackage(candidate.packageName)) {
        throw new MarketInstallError('verification-failed', 'The plugin package target is invalid.')
      }
      const isPrivate = candidate.packageRegistry === PRIVATE_REGISTRY_KIND
      const origin = isPrivate ? options.privateRegistryOrigin : NPM_REGISTRY_ORIGIN
      if (origin === undefined || (isPrivate && !candidate.itemId)) {
        throw new MarketInstallError('verification-failed', 'The private Registry is not configured for this Desktop build.')
      }
      const url = isPrivate
        ? \`\${origin}/registry/\${encodeURIComponent(candidate.itemId ?? '')}/\${encodeURIComponent(candidate.packageName)}\`
        : \`\${NPM_REGISTRY_ORIGIN}/\${encodeURIComponent(candidate.packageName)}/latest\`
      let response
      try { response = await http.getJson(url, signal, { allowedOrigin: origin }) }
      catch { throw new MarketInstallError('verification-failed', isPrivate ? 'The private Registry package could not be verified.' : 'The plugin package could not be verified with npm.') }
      let finalOrigin
      try { finalOrigin = new URL(response.finalUrl).origin }
      catch { throw new MarketInstallError('verification-failed', 'The Registry verification response was invalid.') }
      if (finalOrigin !== origin || response.value === null || typeof response.value !== 'object' || Array.isArray(response.value)) {
        throw new MarketInstallError('verification-failed', 'The Registry verification response was invalid.')
      }
      const document = response.value as Record<string, unknown>
      let manifest = document
      if (isPrivate) {
        const tags = document['dist-tags']
        const versions = document.versions
        const latest = tags !== null && typeof tags === 'object' && !Array.isArray(tags) ? (tags as Record<string, unknown>).latest : undefined
        const versionDocument = versions !== null && typeof versions === 'object' && !Array.isArray(versions) && typeof latest === 'string' ? (versions as Record<string, unknown>)[latest] : undefined
        if (versionDocument === null || typeof versionDocument !== 'object' || Array.isArray(versionDocument)) {
          throw new MarketInstallError('verification-failed', 'The private Registry did not return a latest package.')
        }
        manifest = versionDocument as Record<string, unknown>
      }
      if (manifest.name !== candidate.packageName || !stableExactVersion(manifest.version)) {
        throw new MarketInstallError('verification-failed', 'The Registry package identity did not match the catalog.')
      }
      const dsh = manifest.dsh
      const bundle = dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh) ? (dsh as Record<string, unknown>).bundle : undefined
      const patch = bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle) ? (bundle as Record<string, unknown>).patch : undefined
      if (!safeBundlePatch(patch)) throw new MarketInstallError('verification-failed', 'The package does not declare a valid DSH bundle.')
      return { version: manifest.version as string }
    },
  }
}

`

/**
 * 一次包操作期间存在的临时 pnpm 配置。注释里写清三件事：为什么只剩
 * `.npmrc` 这条路、文件何时出现何时消失、Windows 上 0o600 并不生效。
 */
const NPMRC_SUPPORT = `  /** The pnpm settings one package operation needs; empty when the product adds none. */
  private async productNpmrcLines(): Promise<readonly string[]> {
    const lines: string[] = []
    /* product npmrc lines */
    if (this.registryOrigin !== undefined) {
      const registry = \`\${this.registryOrigin}/registry/by-package/\`
      const token = await this.registryToken?.() ?? ''
      if (token !== '' && !/^sk-\\S{1,509}$/u.test(token)) {
        throw new MarketInstallError('operation-failed', 'The API Key format is invalid.')
      }
      // Only the product scope is routed to the private Registry; every other
      // dependency keeps resolving through the registry the manager asks.
      lines.push(\`\${PRIVATE_REGISTRY_SCOPE}:registry=\${registry}\`)
      // Authorization is per plugin on the server; an anonymous operation is
      // still allowed so a public package never requires a signed-in user.
      if (token !== '') lines.push(\`//\${new URL(registry).host}/registry/:_authToken=\${token}\`)
    }
    return lines
  }

  /**
   * Run one package operation with the product pnpm configuration in place.
   *
   * pnpm reads \`.npmrc\` from the directory it runs in, which is the profile
   * directory. That file is the only channel left: the official plugin manager
   * builds its own argv, and the environment every package run starts from has
   * already dropped each credential-shaped name. Nothing here is a persistent
   * rewrite of the profile's package-manager configuration — the file exists
   * for the duration of one operation and goes away in \`finally\`, and one left
   * behind by a killed process is removed when this service starts.
   *
   * The first line is the product marker. A \`.npmrc\` without it belongs to the
   * user, and the operation refuses rather than overwriting or merging it.
   *
   * The file is created 0o600, which Windows does not enforce; there its
   * protection is its lifetime, not its permissions.
   */
  private async withProductNpmrc<T>(operation: () => Promise<T>): Promise<T> {
    const lines = await this.productNpmrcLines()
    if (lines.length === 0) return await operation()
    const dir = this.profile().dir
    const path = join(dir, PRODUCT_NPMRC_FILENAME)
    let existing: string | undefined
    try { existing = await readFile(path, 'utf8') }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new MarketInstallError('operation-failed', 'The profile package-manager configuration could not be read.')
      }
    }
    if (existing !== undefined && !existing.startsWith(PRODUCT_NPMRC_MARKER)) {
      throw new MarketInstallError(
        'conflict',
        'The active profile has its own package-manager configuration file, so the plugin market cannot configure this operation. Move that file aside and try again.',
      )
    }
    await writeFile(path, \`\${PRODUCT_NPMRC_MARKER}\\n\${lines.join('\\n')}\\n\`, { encoding: 'utf8', mode: 0o600 })
    try { return await operation() }
    finally { await removeProductNpmrc(dir) }
  }

`

export function addPrivateRegistrySupport(files, origin) {
  const market = new URL(origin)
  if (market.protocol !== 'https:' || market.username || market.password || market.search || market.hash) {
    throw new Error('prepare-desktop: private Registry market origin must be credential-free HTTPS')
  }
  // Declare the widened schema to the market: listings only include self-hosted
  // entries for clients that send this header, so desktop builds whose schema
  // still rejects non-npm registries keep receiving the payload they can parse.
  const newline = String.fromCharCode(10)
  const userAgentLine = "        'user-agent': 'dsh-community-market/0.1',"
  const http = replaceOnce(
    files.http,
    [userAgentLine, '      },'].join(newline),
    [userAgentLine, "        'x-dsh-catalog-registries': 'npm tokenscowork',", '      },'].join(newline),
    'catalog registries capability header',
  )
  const contracts = widenContracts(files)

  /* ------------------------- 安装服务 ------------------------- */
  let service = widenInstallCandidateRegistry(files.service)
  service = replaceOnce(service, "import { isAbsolute, resolve } from 'node:path'",
    "import { readFile, unlink, writeFile } from 'node:fs/promises'\nimport { isAbsolute, join, resolve } from 'node:path'", 'service node imports')
  service = replaceOnce(service, "const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'",
    `const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
/** Public npm as pnpm compares registries: lower-case host, trailing slash. */
const NPM_REGISTRY = \`\${NPM_REGISTRY_ORIGIN}/\`
const PRIVATE_REGISTRY_KIND = 'tokenscowork'
/** The npm scope the product publishes under, and the only one routed privately. */
const PRIVATE_REGISTRY_SCOPE = '@tokensapi'
const PRODUCT_NPMRC_FILENAME = '.npmrc'
const PRODUCT_NPMRC_MARKER = '# dsh-community-market: written for one package operation and removed after it'

/**
 * Remove a product \`.npmrc\` a killed process left in the profile directory.
 * A file whose first line is not the product marker belongs to the user and is
 * never touched.
 * @param dir - profile directory.
 */
export async function removeProductNpmrc(dir: string): Promise<void> {
  let existing: string
  try { existing = await readFile(join(dir, PRODUCT_NPMRC_FILENAME), 'utf8') }
  catch { return }
  if (!existing.startsWith(PRODUCT_NPMRC_MARKER)) return
  await unlink(join(dir, PRODUCT_NPMRC_FILENAME)).catch(() => {})
}`, 'registry constants')
  service = replaceOnce(service, "interface InstallCandidate {\n  readonly key: string\n  readonly sourceRecordId: string\n  readonly providerId: string\n  readonly itemId: string\n  readonly displayName: string\n  readonly packageName?: string\n  readonly source?: NormalizedGitHubInstallSource", "interface InstallCandidate {\n  readonly key: string\n  readonly sourceRecordId: string\n  readonly providerId: string\n  readonly itemId: string\n  readonly displayName: string\n  readonly packageName?: string\n  readonly packageRegistry?: 'npm' | 'tokenscowork'\n  readonly source?: NormalizedGitHubInstallSource", 'install candidate registry')
  service = replaceOnce(service, "candidate: Pick<InstallCandidate, 'packageName'>", "candidate: Pick<InstallCandidate, 'packageName' | 'packageRegistry'> & { readonly itemId?: string }", 'verifier candidate registry')
  service = replaceOnce(service, "export interface MarketInstallCandidateInput {\n  readonly packageName?: string\n  readonly source?: NormalizedGitHubInstallSource\n}", "export interface MarketInstallCandidateInput {\n  readonly packageName?: string\n  readonly packageRegistry?: 'npm' | 'tokenscowork'\n  readonly itemId?: string\n  readonly source?: NormalizedGitHubInstallSource\n}", 'verifier input registry')
  service = replaceOnce(service, "  readonly logFailure?: (message: string) => void", "  readonly logFailure?: (message: string) => void\n  /** Product overlay: origin of the private Registry proxy; absent disables it. */\n  readonly registryOrigin?: string\n  /** Product overlay: short-lived customer API Key used only for the private Registry proxy. */\n  readonly registryToken?: () => Promise<string | undefined>", 'install options registry')
  service = replaceOnce(service, "  private readonly logFailure: ((message: string) => void) | undefined", "  private readonly logFailure: ((message: string) => void) | undefined\n  private readonly updateRegistry = new Map<string, { readonly packageRegistry: 'npm' | 'tokenscowork'; readonly itemId: string }>()\n  private readonly registryOrigin: string | undefined\n  private readonly registryToken: (() => Promise<string | undefined>) | undefined", 'registry option fields')
  service = replaceOnce(service, "    this.logFailure = options.logFailure", "    this.logFailure = options.logFailure\n    this.registryOrigin = options.registryOrigin\n    this.registryToken = options.registryToken", 'registry option assignment')
  service = replaceOnce(service, "      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid market install ${label}`)\n    }\n  }",
    "      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid market install ${label}`)\n    }\n    // A product .npmrc a killed process left behind is cleared before the first operation.\n    try { void removeProductNpmrc(this.profile().dir).catch(() => {}) } catch {}\n  }", 'registry startup cleanup')

  const verifierStart = '/** Resolve npm `latest` and confirm only the minimum DSH package shape. */'
  const verifierEnd = '/** Combine the stable npm verifier and the pinned GitHub manifest verifier. */'
  const start = service.indexOf(verifierStart)
  const end = service.indexOf(verifierEnd)
  if (start < 0 || end < 0 || end <= start) throw new Error('prepare-desktop: private Registry verifier anchors changed')
  service = service.slice(0, start) + PRIVATE_VERIFIER + service.slice(end)
  service = replaceOnce(service, "  const npm = createNpmRegistryVerifier(http)\n", "  const npm = createNpmRegistryVerifier(http, options)\n", 'verifier options')
  service = replaceOnce(service, 'npm.verify({ packageName: candidate.packageName }, signal)', 'npm.verify(candidate, signal)', 'preserve registry verification identity')
  service = replaceOnce(service, "export function createMarketPackageVerifier(\n  http: CatalogHttpClient,\n): MarketPackageVerifier {", "export function createMarketPackageVerifier(\n  http: CatalogHttpClient,\n  options: { privateRegistryOrigin?: string } = {},\n): MarketPackageVerifier {", 'market verifier options')
  service = replaceOnce(service, "        || (packageName !== undefined && !marketManagedPackage(packageName))", "        || (packageName !== undefined && !marketManagedPackage(packageName))\n        || (packageName !== undefined && item.package?.registry !== 'npm' && item.package?.registry !== PRIVATE_REGISTRY_KIND)", 'candidate registry validation')
  service = replaceOnce(service, "        ...(packageName === undefined ? {} : { packageName }),\n        ...(source === undefined ? {} : { source }),", "        ...(packageName === undefined ? {} : { packageName }),\n        ...(packageName === undefined ? {} : { packageRegistry: item.package?.registry ?? 'npm' }),\n        ...(source === undefined ? {} : { source }),", 'candidate registry capture')
  service = replaceOnce(service, '  private packageManagerError(message: string, details: string): MarketInstallError {',
    `${NPMRC_SUPPORT}  private packageManagerError(message: string, details: string): MarketInstallError {`, 'product npmrc support')

  /* ---------------- 包操作：临时 .npmrc + 默认 registry ---------------- */
  // 安装与卸载都在产品配置就位时运行；默认 registry 固定公共 npm，私有
  // 作用域由 .npmrc 的 scope 行接管，第三方依赖不会被路由到私有 Registry。
  service = replaceOnce(service, "verification = await this.verifier.verify(candidate, operationSignal)",
    "verification = await this.verifier.verify({ ...candidate, itemId: candidate.itemId, ...(candidate.packageRegistry === undefined ? {} : { packageRegistry: candidate.packageRegistry }) }, operationSignal)",
    'private verifier input')
  service = replaceOnce(service, "        () => this.manager.installBundle(target, { enabled: true, saveExact: true }),",
    "        () => this.withProductNpmrc(() => this.manager.installBundle(target, { enabled: true, saveExact: true, registry: NPM_REGISTRY })),",
    'private install routing')
  service = replaceOnce(service, "        () => this.manager.removeBundle(intent.packageName),\n        'The plugin could not be removed.',",
    "        () => this.withProductNpmrc(() => this.manager.removeBundle(intent.packageName)),\n        'The plugin could not be removed.',",
    'private uninstall routing')
  service = replaceOnce(service, "        () => this.manager.removeBundle(intent.packageName),\n        'The plugin could not be removed, so the update did not start and nothing changed.',",
    "        () => this.withProductNpmrc(() => this.manager.removeBundle(intent.packageName)),\n        'The plugin could not be removed, so the update did not start and nothing changed.',",
    'private update removal routing')
  service = replaceOnce(service, "        () => this.manager.installBundle(`${intent.packageName}@${intent.version}`, { enabled: intent.enabled, saveExact: true }),",
    "        () => this.withProductNpmrc(() => this.manager.installBundle(`${intent.packageName}@${intent.version}`, { enabled: intent.enabled, saveExact: true, registry: NPM_REGISTRY })),",
    'private update install routing')
  // 产品自己的拒绝（用户写的 .npmrc、格式不对的 API Key）本身就带着能给用户看
  // 的 code，不能被当成包管理器的失败重新包装，否则用户只看到一条 pnpm 输出。
  service = replaceOnce(service,
    "    } catch (cause) {\n      throw this.packageManagerError(\n        'The plugin manager could not run the package operation.',",
    "    } catch (cause) {\n      if (cause instanceof MarketInstallError) throw cause\n      throw this.packageManagerError(\n        'The plugin manager could not run the package operation.',",
    'product refusal reaches the user')

  /* -------------------- 更新检查：按插件授权 -------------------- */
  // 更新角标用刚授权过的目录给出的版本提示；预览和执行各自独立再授权、
  // 再做包校验，所以一个过期的角标不会放过一次未授权的更新。
  service = replaceOnce(service, "    allowedPackages: ReadonlySet<string>,", "    allowedPackages: ReadonlySet<string> | ReadonlyMap<string, UpdateTarget>,", 'update registry map type')
  service = replaceOnce(service, "    const result: MarketInstallationView[] = []", "    const result: MarketInstallationView[] = []\n    if (allowedPackages instanceof Map) {\n      this.updateRegistry.clear()\n      for (const [name, target] of allowedPackages) this.updateRegistry.set(name, target)\n    }", 'update registry map capture')
  service = replaceOnce(service, `        if (!allowedPackages.has(item.packageName)) return { ...item, updateStatus: 'unavailable' as const }
        try {
          const latest = await this.verifier.verify({ packageName: item.packageName }, operationSignal)`,
  `        const target = allowedPackages instanceof Map ? allowedPackages.get(item.packageName) : undefined
        if (target === undefined && !allowedPackages.has(item.packageName)) return { ...item, updateStatus: 'unavailable' as const }
        try {
          const latest = target?.latestVersion !== undefined && stableExactVersion(target.latestVersion)
            ? { version: target.latestVersion }
            : await this.verifier.verify({ packageName: item.packageName, ...(target ?? {}) }, operationSignal)`,
  'update registry verification')
  // 授权这一步本来就要去拉一次刚授权过的目录，所以让它把目标一并返回：
  // 预览用的 Registry 与 itemId 和这次授权同源，不依赖上一次检查留下的缓存。
  service = replaceOnce(service, "  async previewUpdate(packageName: string, signal: AbortSignal, authorize: (signal: AbortSignal) => Promise<void>) {",
    "  async previewUpdate(packageName: string, signal: AbortSignal, authorize: UpdateAuthorization) {",
    'update preview registry input')
  service = replaceOnce(service, "  readonly authorize: (signal: AbortSignal) => Promise<void>\n}",
    "  readonly authorize: UpdateAuthorization\n}", 'update intent authorization')
  service = replaceOnce(service, "    await authorize(operationSignal)\n    const current = this.updatableBundle(",
    "    const authorized = await authorize(operationSignal)\n    const current = this.updatableBundle(", 'update preview authorization result')
  service = replaceOnce(service, "    const verified = await this.verifier.verify({ packageName }, operationSignal)",
    "    const updateTarget = authorized ?? this.updateRegistry.get(packageName)\n    const verified = await this.verifier.verify({ packageName, ...(updateTarget ?? {}) }, operationSignal)",
    'update preview registry verification')
  service = replaceOnce(service, "interface UpdateIntent {\n  readonly kind: 'update'\n  readonly packageName: string\n  readonly version: string",
    "/** Which Registry an update reads, and the catalog version hint that saved a lookup. */\nexport interface UpdateTarget {\n  readonly packageRegistry: 'npm' | 'tokenscowork'\n  readonly itemId: string\n  readonly latestVersion?: string\n}\n\n/** Re-authorize one update against a freshly read catalog, and answer with what it offers. */\nexport type UpdateAuthorization = (signal: AbortSignal) => Promise<UpdateTarget | undefined>\n\ninterface UpdateIntent {\n  readonly kind: 'update'\n  readonly packageName: string\n  readonly packageRegistry: 'npm' | 'tokenscowork'\n  readonly itemId?: string\n  readonly version: string",
    'update intent fields')
  service = replaceOnce(service, "    const intent = this.issueIntent({ kind: 'update', packageName, profile, version: verified.version,",
    "    const intent = this.issueIntent({ kind: 'update', packageName, packageRegistry: updateTarget?.packageRegistry ?? 'npm',\n      ...(updateTarget?.itemId === undefined ? {} : { itemId: updateTarget.itemId }), profile, version: verified.version,",
    'update intent registry')

  /* -------------------------- 路由 -------------------------- */
  let routes = replaceOnce(files.routes, "  const updatePackages = async (signal: AbortSignal): Promise<ReadonlySet<string>> => {",
    "  const updatePackages = async (signal: AbortSignal): Promise<ReadonlyMap<string, UpdateTarget>> => {", 'update registry route type')
  routes = replaceOnce(routes, `    return new Set(index.snapshots.flatMap(snapshot => snapshot.items.flatMap(item =>
      item.installSource === undefined && item.package?.registry === 'npm' ? [item.package.name] : [])))`,
  `    return new Map(index.snapshots.flatMap(snapshot => snapshot.items.flatMap(item =>
      item.installSource === undefined && (item.package?.registry === 'npm' || item.package?.registry === 'tokenscowork')
        ? [[item.package.name, { packageRegistry: item.package.registry, itemId: item.id,
          ...(item.latestVersion === undefined ? {} : { latestVersion: item.latestVersion }) }] as const]
        : [])))`, 'update registry route map')
  routes = replaceOnce(routes, `            const authorize = async (operationSignal: AbortSignal) => {
              if (!(await updatePackages(operationSignal)).has(packageName)) {
                throw new MarketInstallError('not-available', 'This plugin is no longer available for update in your organization.')
              }
            }`,
  `            const authorize = async (operationSignal: AbortSignal): Promise<UpdateTarget> => {
              const target = (await updatePackages(operationSignal)).get(packageName)
              if (target === undefined) {
                throw new MarketInstallError('not-available', 'This plugin is no longer available for update in your organization.')
              }
              return target
            }`, 'update registry preview target')
  routes = replaceOnce(routes, "import { MarketInstallError, type MarketInstallService } from '../install/service.js'",
    "import { MarketInstallError, type MarketInstallService, type UpdateTarget } from '../install/service.js'", 'update target import')

  /* -------------------------- 入口 -------------------------- */
  let index = files.index
  index = replaceOnce(index, "const npmRegistryHttp = createRestrictedHttpClient({\n  // This is a compiled-in official registry hostname, never provider input.\n  syntheticProxyHostnames: ['registry.npmjs.org'],\n})", `let productMarketRegistryKeyReader: (() => Promise<string>) | undefined\nconst productMarketRegistryOrigin = ${JSON.stringify(market.origin)}\nexport function setProductMarketRegistryKeyReader(reader: () => Promise<string>): void { productMarketRegistryKeyReader = reader }\nconst npmRegistryHttp = createRestrictedHttpClient({\n  // Product Registry origin is compiled from the first-party market config.\n  syntheticProxyHostnames: ['registry.npmjs.org', ${JSON.stringify(market.hostname)}],\n  authorization: async url => url.origin === productMarketRegistryOrigin\n    ? ((key => /^sk-\\\\S{1,509}$/u.test(key) ? 'Bearer ' + key : undefined)(await productMarketRegistryKeyReader?.() ?? ''))\n    : undefined,\n})`, 'market registry HTTP client')
  index = replaceOnce(index, "  const state = new DeferredMarketStateStore(message => ctx.logger.warn(message))", `  const state = new DeferredMarketStateStore(message => ctx.logger.warn(message))\n  const readMarketKey = async (): Promise<string> => {\n    const credentials = ctx.reflect?.get?.('credentials') as { resolve?: (ref: string) => Promise<{ value?: unknown }> } | undefined\n    if (!credentials?.resolve) return ''\n    const result = await credentials.resolve('TOKENSAPI_API_KEY')\n    const key = typeof result?.value === 'string' ? result.value.trim() : ''\n    return /^sk-\\\\S{1,509}$/u.test(key) ? key : ''\n  }\n  setProductMarketRegistryKeyReader(readMarketKey)`, 'market registry credential reader')
  index = replaceOnce(index, "createMarketPackageVerifier(npmRegistryHttp),", "createMarketPackageVerifier(npmRegistryHttp, { privateRegistryOrigin: productMarketRegistryOrigin }),", 'market verifier registry origin')
  index = replaceOnce(index, "          logFailure: message => ctx.logger.error(message),", "          logFailure: message => ctx.logger.error(message),\n          registryOrigin: productMarketRegistryOrigin,\n          registryToken: readMarketKey,", 'market install registry options')
  // Correct the generated credential regex (one backslash in TypeScript source).
  index = index.replaceAll(String.raw`/^sk-\\S{1,509}$/u`, String.raw`/^sk-\S{1,509}$/u`)

  return { ...files, http, index, service, routes, ...contracts }
}
