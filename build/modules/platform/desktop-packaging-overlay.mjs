// Product packaging policy; invoked by prepare/configure, never executes a build.
// 上游 yarn 按 supportedArchitectures 同时装 x64 与 arm64 两套原生依赖（给 macOS 通用包
// 用）。产品按架构单独打包，另一套只是体积：2.0.17 起 libreoffice-kit 与 uv 每架构
// 150–190 MB，不剔掉安装包翻倍，签名、公证与 NSIS 压缩时间跟着翻倍。
const windowsX64RuntimeExclusions = [
  '!node_modules/@img/sharp-win32-{arm64,ia32}/**',
  '!node_modules/@koromix/koffi-win32-{arm64,ia32}/**',
  '!node_modules/@vscode/ripgrep-win32-{arm64,ia32}/**',
  '!node_modules/node-addon-require-builtin-win32-{arm64,ia32}-msvc/**',
  '!node_modules/node-pty/prebuilds/{darwin-*,linux-*,win32-arm64,win32-ia32}/**',
  '!node_modules/fs-ext/prebuilds/{darwin-*,linux-*}/**',
  '!node_modules/@dataiku/uv-win32-{arm64,ia32}/**',
  '!node_modules/@deepseek-ai/libreoffice-kit-win32-{arm64,ia32}/**',
  '!node_modules/sherpa-onnx-win-{arm64,ia32}/**',
  '!node_modules/**/*.map',
  '!node_modules/**/*.{d.ts,d.mts,d.cts}',
]

/**
 * 从上游通用包的 `mac.x64ArchFiles` 清单推导单架构 macOS 包要剔除的异架构目录。
 * 上游维护那份清单（新增原生依赖时会同步加进去），这里只把 `darwin-*` 换成另一个架构，
 * 不另抄一份包名；清单格式变了立即报错而不是静默少剔。
 * @param build - staging 副本 package.json 的 build 字段。
 * @param arch - 本次打包的 Electron 架构：arm64 或 x64。
 * @returns electron-builder `files` 的排除模式。
 */
export function macForeignArchExclusions(build, arch) {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`configure-product: unsupported macOS architecture ${arch}`)
  const foreign = arch === 'arm64' ? 'x64' : 'arm64'
  const list = build.mac?.x64ArchFiles
  // 2.0.17 是 `**/node_modules/{…}`；2.0.18 起外面再包一层 `{…,Contents/Resources/runtime/**,…}`
  // 把解释器载荷也交给通用包合并。这里只取 node_modules 那组，载荷目录按 DSH_MAC_SMOKE_ARCH 只准备本架构。
  const match = typeof list === 'string' ? /\*\*\/node_modules\/\{([^{}]+)\}/u.exec(list) : null
  if (!match) throw new Error('configure-product: upstream mac.x64ArchFiles format changed')
  const patterns = match[1].split(',').map(entry => entry.trim())
  if (patterns.length === 0 || patterns.some(entry => !entry.includes('darwin-*/**'))) {
    throw new Error('configure-product: upstream mac.x64ArchFiles entry is not a darwin-* package')
  }
  return [
    ...patterns.map(entry => `!node_modules/${entry.replace('darwin-*', `darwin-${foreign}`)}`),
    '!node_modules/node-pty/prebuilds/{win32-*,linux-*}/**',
    '!node_modules/fs-ext/prebuilds/{win32-*,linux-*}/**',
  ]
}
const upstreamReleaseCheck = `  // The workspace check includes the package build and repository-layout gate. Signing
  // material is withheld from every build, test, Loader smoke, and layout subprocess.
  options.run(
    process.execPath,
    ['scripts/prepare-agents-anywhere-release.mjs', '--verify-release'],
    resolve(options.desktopRoot, '..'),
    buildEnvironment,
  )
  options.run(process.execPath, ['scripts/prepare-dsh-market.mjs', '--check'], resolve(options.desktopRoot, '..'), buildEnvironment)
  options.run('yarn', ['run', 'check'], resolve(options.desktopRoot, '..'), buildEnvironment)
`

/** Keep the original Windows x64 exclusions and installer identity. */
export function configureDesktopPackage(desktopPackage, product, packagingTarget) {
  desktopPackage.version = product.version
  // electron-builder uses this for NSIS shortcut tooltips and FileDescription.
  desktopPackage.description = `${product.name} desktop application`
  desktopPackage.build.appId = product.appId
  desktopPackage.build.productName = product.name
  if (desktopPackage.build.afterSign) throw new Error('configure-product: unexpected upstream afterSign hook')
  desktopPackage.build.afterSign = './scripts/product-notarize.mjs'
  desktopPackage.build.win.artifactName = `${product.name}-\${version}-\${arch}-Portable.\${ext}`
  desktopPackage.build.nsis.guid = product.windowsInstallerGuid
  desktopPackage.build.nsis.shortcutName = product.name
  desktopPackage.build.nsis.artifactName = `${product.name}-\${version}-\${arch}-Setup.\${ext}`
  if (!Array.isArray(desktopPackage.build.files)) {
    throw new Error('configure-product: unsupported upstream application files configuration')
  }
  if (packagingTarget === 'windows') {
    desktopPackage.build.files.push(...windowsX64RuntimeExclusions)
  } else if (packagingTarget === 'mac-arm64' || packagingTarget === 'mac-x64') {
    desktopPackage.build.files.push(...macForeignArchExclusions(desktopPackage.build, packagingTarget.slice(4)))
  } else if (packagingTarget !== 'default') {
    throw new Error(`configure-product: unknown packaging target ${packagingTarget}`)
  }
}

/**
 * 上游 afterPack 要求两个架构的 uv 都在包里且可执行；单架构包只保留本架构的，
 * 按 DSH_MAC_ARCH 只检查那一个。未设置架构时保持上游行为（通用包）。
 * @param source - staging 副本中 verify-packaged-runtime.ts 的完整内容。
 * @returns 只检查本架构 uv 的校验源码。
 * @throws 上游校验锚点变化时抛出。
 */
export function alignPackagedAgentsAnywhereCheck(source) {
  const anchor = "    for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES.filter(entry => entry.path.endsWith('/bin/uv'))) {"
  if (source.split(anchor).length !== 2) throw new Error('configure-product: packaged uv check anchor changed')
  return source.replace(anchor, `    const selectedArch = process.env.DSH_MAC_ARCH === 'x64' ? 'x86_64' : process.env.DSH_MAC_ARCH === 'arm64' ? 'arm64' : undefined
    for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES.filter(entry => entry.path.endsWith('/bin/uv') && (selectedArch === undefined || entry.arch === selectedArch))) {`)
}

/** Windows owns shared CI quality checks; do not rerun them in macOS release. */
export function alignMacReleaseChecks(releaseMac) {
  if (!releaseMac.includes(upstreamReleaseCheck)) {
    throw new Error('configure-product: cannot locate redundant macOS release check')
  }
  const builder = "    'exec', 'electron-builder', '--mac', 'dmg', '--universal',"
  if (releaseMac.split(builder).length !== 2) {
    throw new Error('configure-product: cannot locate unique macOS packaging command')
  }
  const runtime = `      prepareFsExtForElectron({ platform: 'darwin', arch: 'arm64', desktopRoot })
      prepareFsExtForElectron({ platform: 'darwin', arch: 'x64', desktopRoot })
      prepareInstalledMacUniversalRuntime(desktopRoot)`
  if (!releaseMac.includes(runtime)) throw new Error('configure-product: cannot locate universal runtime preparation')
  // 上游的 node:fs 导入项随版本变化（2.0.17 只有 rmSync，2.0.18 多了 readFileSync）；按现有导入补齐我们用到的名字，
  // 而不是替换固定句子——替换不中会静默留下未导入的 existsSync/chmodSync，到 typecheck 才暴露。
  const fsImport = /import \{ ([^}]+) \} from 'node:fs'/u
  if (!fsImport.test(releaseMac)) throw new Error('configure-product: cannot locate the node:fs import in release-mac.ts')
  return releaseMac.replace(upstreamReleaseCheck,
    '  // TokensCowork product assembly owns the release quality gates before packaging.\n')
    .replace(builder, "    'exec', 'electron-builder', '--mac', 'dmg', `--${releaseEnvironment.DSH_MAC_ARCH}`,\n    '--publish', 'never',")
    .replace("'--config.mac.notarize=true'", "'--config.mac.notarize=false'")
    .replace(fsImport, (_line, names) => {
      const imported = new Set(names.split(',').map(name => name.trim()).filter(Boolean))
      for (const name of ['existsSync', 'chmodSync']) imported.add(name)
      return `import { ${[...imported].join(', ')} } from 'node:fs'`
    })
    .replace("import { prepareInstalledMacUniversalRuntime }", "import { MACOS_UNIVERSAL_NATIVE_ENTRIES }")
    .replace(runtime, `      const arch = process.env.DSH_MAC_ARCH
      if (arch !== 'arm64' && arch !== 'x64') throw new Error('Explicit native macOS architecture is required')
      prepareFsExtForElectron({ platform: 'darwin', arch, desktopRoot })
      for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES.filter(entry => entry.arch === (arch === 'x64' ? 'x86_64' : 'arm64'))) {
        const file = resolve(desktopRoot, entry.path)
        if (!existsSync(file)) throw new Error('Missing native runtime: ' + entry.path)
        if (entry.path.endsWith('/spawn-helper')) chmodSync(file, 0o755)
      }`)
}

/** Validate the selected native package, retaining every signature/notarization gate. */
export function alignMacReleaseVerification(source) {
  const main = "    options.run('lipo', [executablePath, '-verify_arch', 'x86_64'])\n    options.run('lipo', [executablePath, '-verify_arch', 'arm64'])"
  const entries = 'for (const entry of options.nativeEntries ?? MACOS_UNIVERSAL_NATIVE_ENTRIES)'
  const staple = "    options.run('xcrun', ['stapler', 'validate', appPath])\n"
  if (source.split(main).length !== 2 || source.split(entries).length !== 2 || source.split(staple).length !== 2) {
    throw new Error('configure-product: macOS verification anchors changed')
  }
  return source.replace(main, `    const arch = process.env.DSH_MAC_ARCH
    if (arch !== 'arm64' && arch !== 'x64') throw new Error('Explicit native macOS architecture is required')
    const binaryArch = arch === 'x64' ? 'x86_64' : 'arm64'
    options.run('lipo', [executablePath, '-verify_arch', binaryArch])`)
    .replace(entries, 'for (const entry of (options.nativeEntries ?? MACOS_UNIVERSAL_NATIVE_ENTRIES).filter(entry => entry.arch === binaryArch))')
    // stapler validate 要向 Apple 查询票据，偶发断连（NSURLError -1005）；断连重试三次，校验不放宽。
    .replace(staple, `    for (let attempt = 1; ; attempt++) {
      try {
        options.run('xcrun', ['stapler', 'validate', appPath])
        break
      } catch (error) {
        if (attempt >= 3) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TOKENS_STAPLE_RETRY_MS ?? 30_000))
      }
    }
`)
}

/** Preserve the explicit native architecture selected by the outer build. */
export function alignFsExtArchitecture(fsExtPrepareSource) {
  const fsExtCliAnchor = '  prepareFsExtForElectron({ log: message => console.log(message) })'
  if (fsExtPrepareSource.split(fsExtCliAnchor).length !== 2) {
    throw new Error('prepare-desktop: upstream fs-ext CLI anchor is missing or ambiguous')
  }
  return fsExtPrepareSource.replace(fsExtCliAnchor,
      "  prepareFsExtForElectron({ arch: process.argv[2] ?? process.arch, log: message => console.log(message) })")
}

/** Check the actual signatures for the selected native architecture and every Helper. */
export function alignMacEntitlementArchitecture(source) {
  const anchor = "    for (const arch of ['arm64', 'x86_64']) {"
  if (source.split(anchor).length !== 2) throw new Error('configure-product: macOS entitlement architecture anchor changed')
  return source.replace(anchor, "    const selected = process.env.DSH_MAC_ARCH\n    if (selected !== 'arm64' && selected !== 'x64') throw new Error('Explicit native macOS architecture is required')\n    for (const arch of [selected === 'x64' ? 'x86_64' : 'arm64']) {")
}
