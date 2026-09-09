/* Build-only support for the optional TokensCowork private Registry. */
function replaceOnce(source, anchor, replacement, label) {
  if (source.split(anchor).length !== 2) throw new Error(`prepare-desktop: private Registry anchor changed: ${label}`)
  return source.replace(anchor, replacement)
}

function widenRegistrySchema(source) {
  return replaceOnce(source, '"const": "npm"', '"enum": ["npm", "tokenscowork"]', 'provider package registry')
}

export function addPrivateRegistrySupport(files, origin) {
  const market = new URL(origin)
  if (market.protocol !== 'https:' || market.username || market.password || market.search || market.hash) {
    throw new Error('prepare-desktop: private Registry market origin must be credential-free HTTPS')
  }
  let providerSchema = widenRegistrySchema(files.providerSchema)
  let snapshotSchema = widenRegistrySchema(files.snapshotSchema)
  let providerTypes = replaceOnce(files.providerTypes, "registry: 'npm'", "registry: 'npm' | 'tokenscowork'", 'provider package type')
  let snapshotTypes = replaceOnce(files.snapshotTypes, "registry: 'npm'", "registry: 'npm' | 'tokenscowork'", 'snapshot package type')
  let types = replaceOnce(files.types, "readonly registry: 'npm'", "readonly registry: 'npm' | 'tokenscowork'", 'normalized package type')
  let identity = replaceOnce(
    files.identity,
    "export function normalizePackageIdentity(packageIdentity: PackageIdentity): NormalizedPackageIdentity {\n  return { registry: 'npm', name: packageIdentity.name }\n}",
    "export function normalizePackageIdentity(packageIdentity: PackageIdentity): NormalizedPackageIdentity {\n  if (packageIdentity.registry !== 'npm' && packageIdentity.registry !== 'tokenscowork') {\n    throw new CatalogContractError('identity', [semanticIssue('/package/registry', 'must be npm or tokenscowork')])\n  }\n  return { registry: packageIdentity.registry, name: packageIdentity.name }\n}",
    'package identity normalization',
  )

  let service = files.service
  let routes = files.routes ?? ''
  service = replaceOnce(service, "const NPM_REGISTRY = `${NPM_REGISTRY_ORIGIN}/`", "const NPM_REGISTRY = `${NPM_REGISTRY_ORIGIN}/`\nconst PRIVATE_REGISTRY_KIND = 'tokenscowork'", 'registry constants')
  service = replaceOnce(service, "interface InstallCandidate {\n  readonly key: string\n  readonly sourceRecordId: string\n  readonly providerId: string\n  readonly itemId: string\n  readonly displayName: string\n  readonly packageName?: string\n  readonly source?: NormalizedGitHubInstallSource", "interface InstallCandidate {\n  readonly key: string\n  readonly sourceRecordId: string\n  readonly providerId: string\n  readonly itemId: string\n  readonly displayName: string\n  readonly packageName?: string\n  readonly packageRegistry?: 'npm' | 'tokenscowork'\n  readonly source?: NormalizedGitHubInstallSource", 'install candidate registry')
  service = replaceOnce(service, "candidate: Pick<InstallCandidate, 'packageName'>", "candidate: Pick<InstallCandidate, 'packageName' | 'packageRegistry'> & { readonly itemId?: string }", 'verifier candidate registry')
  service = replaceOnce(service, "export interface MarketInstallCandidateInput {\n  readonly packageName?: string\n  readonly source?: NormalizedGitHubInstallSource\n}", "export interface MarketInstallCandidateInput {\n  readonly packageName?: string\n  readonly packageRegistry?: 'npm' | 'tokenscowork'\n  readonly itemId?: string\n  readonly source?: NormalizedGitHubInstallSource\n}", 'verifier input registry')
  service = replaceOnce(service, "readonly logFailure?: (message: string) => void", "readonly logFailure?: (message: string) => void\n  /** Product overlay: short-lived customer API Key used only for the private Registry proxy. */\n  readonly registryOrigin?: string\n  readonly registryToken?: () => Promise<string | undefined>", 'install options registry')
  service = replaceOnce(service, "  private readonly logFailure: ((message: string) => void) | undefined", "  private readonly logFailure: ((message: string) => void) | undefined\n  private readonly updateRegistry = new Map<string, { readonly packageRegistry: 'npm' | 'tokenscowork'; readonly itemId: string }>()\n  private readonly registryOrigin: string | undefined\n  private readonly registryToken: (() => Promise<string | undefined>) | undefined", 'registry option fields')
  service = replaceOnce(service, "    this.logFailure = options.logFailure", "    this.logFailure = options.logFailure\n    this.registryOrigin = options.registryOrigin\n    this.registryToken = options.registryToken", 'registry option assignment')
  service = replaceOnce(service, "function packageManagerDetails(\n  args: readonly string[],", "function packageManagerDetails(\n  args: readonly string[],", 'package details anchor')
  service = replaceOnce(service, "  const sections = [\n    `pnpm ${args.join(' ')}`,", "  const safeArgs = args.map(value => value.replace(/(_authToken=)[^\\s]+/u, '$1[redacted]'))\n  const sections = [\n    `pnpm ${safeArgs.join(' ')}`,", 'redact registry token')

  const verifierStart = '/** Resolve npm `latest` and confirm only the minimum DSH package shape. */'
  const verifierEnd = '/** Combine the stable npm verifier and the pinned GitHub manifest verifier. */'
  const start = service.indexOf(verifierStart)
  const end = service.indexOf(verifierEnd)
  if (start < 0 || end < 0 || end <= start) throw new Error('prepare-desktop: private Registry verifier anchors changed')
  const verifier = `/** Resolve public npm or the product private Registry and confirm the minimum DSH package shape. */
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
  service = service.slice(0, start) + verifier + service.slice(end)
  service = replaceOnce(service, "  const npm = createNpmRegistryVerifier(http)\n", "  const npm = createNpmRegistryVerifier(http, options)\n", 'verifier options')
  service = replaceOnce(service, "export function createMarketPackageVerifier(\n  http: CatalogHttpClient,\n): MarketPackageVerifier {", "export function createMarketPackageVerifier(\n  http: CatalogHttpClient,\n  options: { privateRegistryOrigin?: string } = {},\n): MarketPackageVerifier {", 'market verifier options')
  service = replaceOnce(service, "        || (packageName !== undefined && !marketManagedPackage(packageName))", "        || (packageName !== undefined && !marketManagedPackage(packageName))\n        || (packageName !== undefined && item.package?.registry !== 'npm' && item.package?.registry !== PRIVATE_REGISTRY_KIND)", 'candidate registry validation')
  service = replaceOnce(service, "        ...(packageName === undefined ? {} : { packageName }),\n        ...(source === undefined ? {} : { source }),", "        ...(packageName === undefined ? {} : { packageName }),\n        ...(packageName === undefined ? {} : { packageRegistry: item.package?.registry ?? 'npm' }),\n        ...(source === undefined ? {} : { source }),", 'candidate registry capture')
  service = replaceOnce(service, "    allowedPackages: ReadonlySet<string>,", "    allowedPackages: ReadonlySet<string> | ReadonlyMap<string, { readonly packageRegistry: 'npm' | 'tokenscowork'; readonly itemId: string }>,", 'update registry map type')
  service = replaceOnce(service, "    const result: MarketInstallationView[] = []", "    const result: MarketInstallationView[] = []\n    if (allowedPackages instanceof Map) {\n      this.updateRegistry.clear()\n      for (const [name, target] of allowedPackages) this.updateRegistry.set(name, target)\n    }", 'update registry map capture')
  service = replaceOnce(service, "        if (!allowedPackages.has(item.packageName)) return { ...item, version: state.version, updateStatus: 'unavailable' as const }\n        try {\n          const latest = await this.verifier.verify({ packageName: item.packageName }, operationSignal)", "        const target = allowedPackages instanceof Map ? allowedPackages.get(item.packageName) : undefined\n        if (target === undefined && !allowedPackages.has(item.packageName)) return { ...item, version: state.version, updateStatus: 'unavailable' as const }\n        try {\n          const latest = await this.verifier.verify({ packageName: item.packageName, ...(target ?? {}) }, operationSignal)", 'update registry verification')
  service = replaceOnce(service, "  async previewUpdate(packageName: string, signal: AbortSignal, authorize: (signal: AbortSignal) => Promise<void>) {", "  async previewUpdate(packageName: string, signal: AbortSignal, authorize: (signal: AbortSignal) => Promise<void>, target?: { readonly packageRegistry: 'npm' | 'tokenscowork'; readonly itemId: string }) {", 'update preview registry input')
  service = replaceOnce(service, "    const verified = await this.verifier.verify({ packageName }, operationSignal)", "    const updateTarget = target ?? this.updateRegistry.get(packageName)\n    const verified = await this.verifier.verify({ packageName, ...(updateTarget ?? {}) }, operationSignal)", 'update preview registry verification')
  service = replaceOnce(service, "    const intent = this.issueIntent({ kind: 'update', packageName, profile, version: verified.version,\n      updateFrom: state.version, dependency: state.dependency, expiresAt, authorize })", "    const intent = this.issueIntent({ kind: 'update', packageName, packageRegistry: updateTarget?.packageRegistry ?? 'npm', ...(updateTarget?.itemId === undefined ? {} : { itemId: updateTarget.itemId }), profile, version: verified.version,\n      updateFrom: state.version, dependency: state.dependency, expiresAt, authorize })", 'update intent registry')
  service = replaceOnce(service, "interface UpdateIntent {\n  readonly kind: 'update'\n  readonly packageName: string\n  readonly version: string", "interface UpdateIntent {\n  readonly kind: 'update'\n  readonly packageName: string\n  readonly packageRegistry: 'npm' | 'tokenscowork'\n  readonly itemId?: string\n  readonly version: string", 'update intent fields')
  service = replaceOnce(service, "verification = await this.verifier.verify(candidate, operationSignal)", "verification = await this.verifier.verify({ ...candidate, itemId: candidate.itemId, ...(candidate.packageRegistry === undefined ? {} : { packageRegistry: candidate.packageRegistry }) }, operationSignal)", 'private verifier input')
  service = replaceOnce(service, "const target = candidate.source === undefined\n        ? `${packageName}@${verification.version}`\n        : githubPackageTarget(candidate.source)\n      await this.runPnpm([\n        'add',\n        ...(candidate.source === undefined ? this.installOptions(packageName) : ['--save-exact']),\n        target,", "const target = candidate.source === undefined\n        ? `${packageName}@${verification.version}`\n        : githubPackageTarget(candidate.source)\n      const options = candidate.source === undefined ? await this.installOptions(candidate) : ['--save-exact']\n      await this.runPnpm([\n        'add',\n        ...options,\n        target,", 'private install options')
  const oldOptions = `  private installOptions(packageName: string): readonly string[] {\n    const scope = packageName.startsWith('@') ? packageName.split('/', 1)[0] : undefined\n    return [\n      '--save-exact',\n      \`--registry=\${NPM_REGISTRY}\`,\n      ...(scope === undefined ? [] : [\`--\${scope}:registry=\${NPM_REGISTRY}\`]),\n    ]\n  }`
  const newOptions = `  private async installOptions(candidate: Pick<InstallCandidate, 'packageName' | 'packageRegistry' | 'itemId'>): Promise<readonly string[]> {\n    const packageName = candidate.packageName\n    const scope = packageName.startsWith('@') ? packageName.split('/', 1)[0] : undefined\n    if (candidate.packageRegistry !== PRIVATE_REGISTRY_KIND) {\n      return ['--save-exact', \`--registry=\${NPM_REGISTRY}\`, ...(scope === undefined ? [] : [\`--\${scope}:registry=\${NPM_REGISTRY}\`])]\n    }\n    if (!this.registryOrigin || !candidate.itemId || !this.registryToken) throw new MarketInstallError('operation-failed', 'The private Registry is not configured.')\n    const token = await this.registryToken()\n    if (typeof token !== 'string' || !/^sk-\\S{1,509}$/u.test(token)) throw new MarketInstallError('operation-failed', 'A valid API Key is required for private plugin installation.')\n    const registry = \`\${this.registryOrigin}/registry/\${encodeURIComponent(candidate.itemId)}/\`\n    const auth = \`//\${new URL(registry).host}/registry/\${encodeURIComponent(candidate.itemId)}/:_authToken=\${token}\`\n    return ['--save-exact', \`--registry=\${registry}\`, auth, ...(scope === undefined ? [] : [\`--\${scope}:registry=\${registry}\`])]\n  }`
  const privateOptions = newOptions
    .replace("Pick<InstallCandidate, 'packageName' | 'packageRegistry' | 'itemId'>", "Pick<InstallCandidate, 'packageName' | 'packageRegistry'> & { readonly itemId?: string }")
    .replace('const packageName = candidate.packageName' + String.fromCharCode(10), "const packageName = candidate.packageName" + String.fromCharCode(10) + "    if (typeof packageName !== 'string') throw new MarketInstallError('operation-failed', 'The package name is unavailable.')" + String.fromCharCode(10))
  service = replaceOnce(service, oldOptions, privateOptions, 'private registry package-manager options')
  service = service.replace("this.installOptions(intent.packageName)", "await this.installOptions({ packageName: intent.packageName, packageRegistry: 'npm' })")
  service = service.replace("await this.installOptions({ packageName: intent.packageName, packageRegistry: 'npm' })", "await this.installOptions({ packageName: intent.packageName, packageRegistry: intent.packageRegistry, ...(intent.itemId === undefined ? {} : { itemId: intent.itemId }) })")

  if (routes !== '') {
    routes = replaceOnce(routes, "  const updatePackages = async (signal: AbortSignal): Promise<ReadonlySet<string>> => {", "  const updatePackages = async (signal: AbortSignal): Promise<ReadonlyMap<string, { readonly packageRegistry: 'npm' | 'tokenscowork'; readonly itemId: string }>> => {", 'update registry route type')
    routes = replaceOnce(routes, "    return new Set(index.snapshots.flatMap(snapshot => snapshot.items.flatMap(item =>\n      item.installSource === undefined && item.package?.registry === 'npm' ? [item.package.name] : [])))", "    return new Map(index.snapshots.flatMap(snapshot => snapshot.items.flatMap(item =>\n      item.installSource === undefined && (item.package?.registry === 'npm' || item.package?.registry === 'tokenscowork')\n        ? [[item.package.name, { packageRegistry: item.package.registry, itemId: item.id }]]\n        : [])))", 'update registry route map')
    routes = replaceOnce(routes, "            const authorize = async (operationSignal: AbortSignal) => {\n              const packages = await updatePackages(operationSignal)", "            let packages: ReadonlyMap<string, { readonly packageRegistry: 'npm' | 'tokenscowork'; readonly itemId: string }> = new Map()\n            const authorize = async (operationSignal: AbortSignal) => {\n              packages = await updatePackages(operationSignal)", 'update registry authorize target')
    routes = replaceOnce(routes, "            preview = await install.previewUpdate(target.packageName, signal, authorize)", "            preview = await install.previewUpdate(target.packageName, signal, authorize, packages.get(target.packageName))", 'update registry preview target')
  }

  let index = files.index
  index = replaceOnce(index, "const npmRegistryHttp = createRestrictedHttpClient({\n  // This is a compiled-in official registry hostname, never provider input.\n  syntheticProxyHostnames: ['registry.npmjs.org'],\n})", `let productMarketRegistryKeyReader: (() => Promise<string>) | undefined\nconst productMarketRegistryOrigin = ${JSON.stringify(market.origin)}\nexport function setProductMarketRegistryKeyReader(reader: () => Promise<string>): void { productMarketRegistryKeyReader = reader }\nconst npmRegistryHttp = createRestrictedHttpClient({\n  // Product Registry origin is compiled from the first-party market config.\n  syntheticProxyHostnames: ['registry.npmjs.org', ${JSON.stringify(market.hostname)}],\n  authorization: async url => url.origin === productMarketRegistryOrigin\n    ? ((key => /^sk-\\\\S{1,509}$/u.test(key) ? 'Bearer ' + key : undefined)(await productMarketRegistryKeyReader?.() ?? ''))\n    : undefined,\n})`, 'market registry HTTP client')
  index = replaceOnce(index, "  const scope = registerMarketSettings(ctx)", `  const scope = registerMarketSettings(ctx)\n  const readMarketKey = async (): Promise<string> => {\n    const credentials = ctx.reflect?.get?.('credentials') as { resolve?: (ref: string) => Promise<{ value?: unknown }> } | undefined\n    if (!credentials?.resolve) return ''\n    const result = await credentials.resolve('TOKENSAPI_API_KEY')\n    const key = typeof result?.value === 'string' ? result.value.trim() : ''\n    return /^sk-\\\\S{1,509}$/u.test(key) ? key : ''\n  }\n  setProductMarketRegistryKeyReader(readMarketKey)`, 'market registry credential reader')
  index = replaceOnce(index, "createMarketPackageVerifier(npmRegistryHttp),", `createMarketPackageVerifier(npmRegistryHttp, { privateRegistryOrigin: productMarketRegistryOrigin }),`, 'market verifier registry origin')
  index = replaceOnce(index, "          logFailure: message => ctx.logger.error(message),", `          logFailure: message => ctx.logger.error(message),\n          registryOrigin: productMarketRegistryOrigin,\n          registryToken: readMarketKey,`, 'market install registry options')
  return { ...files, index, service, routes, identity, types, providerSchema, snapshotSchema, providerTypes, snapshotTypes }
}
