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

/** DSH 0.2 settings derive forms from volatile Config and address profile entry ids. */
export function alignWebSearchSettings(source) {
  source = source.replaceAll('\r\n', '\n')
  const marker = '// TokensCowork: DSH 0.2 search settings adaptation.'
  if (source.includes(marker)) return source
  // 插件自 a3a8135 起按宿主实际导出探测设置契约（0.1 显式安装分区、0.2 volatile Config），无需再改写。
  if (source.includes('import * as dshSettings from "@deepseek-ai/dsh-settings";')
    && source.includes('typeof dshSettings.installSettingsSection === "function"')) return source
  const oldImport = 'import { SettingsConflictError, installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";'
  const schemaEnd = '  deepseekApiKey: z.string().role("secret"),\n});'
  const installStart = '  installSettingsSection(ctx, FREE_SEARCH_NS, Config, config ?? {}, {'
  const installEnd = '\n  });\n\n  ctx.inject(["webServer", "settings"], (sctx) => {'
  const start = source.indexOf(installStart)
  const end = source.indexOf(installEnd, start)
  for (const anchor of [oldImport, schemaEnd, installStart, '  let current = () => config ?? {};', '        sctx.settings,']) {
    if (source.split(anchor).length !== 2) throw new Error('Web-search settings anchor changed')
  }
  if (end < start) throw new Error('Web-search settings installation end changed')
  return (source.slice(0, start) + `  ctx.on("loader/volatile-update", () => {
    cacheGeneration += 1;
    searchCache.clear();
    if (typeof refreshPrompt === "function") refreshPrompt();
  });` + source.slice(end + '\n  });'.length))
    .replace(oldImport, `import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
${marker}
const settingsNamespace = value => value;
function productSearchSettings(settings, entryId) {
  if (!entryId) throw new Error("Search settings require a profile entry id");
  return {
    describe: options => settings.describe(options).map(item => item.ns === entryId ? { ...item, ns: "free-search" } : item),
    mutate: (ns, ops, revision) => settings.mutate(ns === "free-search" ? entryId : ns, ops, revision),
    get writable() { return settings.writable; },
  };
}`)
    .replace(schemaEnd, schemaEnd.replace('});', '}).volatile();'))
    .replace('  let current = () => config ?? {};', '  const current = () => config?.get?.() ?? config ?? {};')
    .replace('        sctx.settings,', '        productSearchSettings(sctx.settings, ctx.fiber.entry?.options.id),')
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
