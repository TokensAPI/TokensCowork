// Product packaging policy; invoked by prepare/configure, never executes a build.
const windowsX64RuntimeExclusions = [
  '!node_modules/@img/sharp-win32-{arm64,ia32}/**',
  '!node_modules/@koromix/koffi-win32-{arm64,ia32}/**',
  '!node_modules/@vscode/ripgrep-win32-{arm64,ia32}/**',
  '!node_modules/node-addon-require-builtin-win32-{arm64,ia32}-msvc/**',
  '!node_modules/node-pty/prebuilds/{darwin-*,linux-*,win32-arm64,win32-ia32}/**',
  '!node_modules/**/*.map',
  '!node_modules/**/*.{d.ts,d.mts,d.cts}',
]
const upstreamReleaseCheck = `  // The workspace check includes the package build and repository-layout gate. Signing
  // material is withheld from every build, test, Loader smoke, and layout subprocess.
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
  }
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
  return releaseMac.replace(upstreamReleaseCheck,
    '  // TokensCowork product assembly owns the release quality gates before packaging.\n')
    .replace(builder, "    'exec', 'electron-builder', '--mac', 'dmg', `--${releaseEnvironment.DSH_MAC_ARCH}`,\n    '--publish', 'never',")
    .replace("'--config.mac.notarize=true'", "'--config.mac.notarize=false'")
    .replace("import { rmSync } from 'node:fs'", "import { rmSync, existsSync, chmodSync } from 'node:fs'")
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
  const entries = 'for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES)'
  if (source.split(main).length !== 2 || source.split(entries).length !== 2) throw new Error('configure-product: macOS verification anchors changed')
  return source.replace(main, `    const arch = process.env.DSH_MAC_ARCH
    if (arch !== 'arm64' && arch !== 'x64') throw new Error('Explicit native macOS architecture is required')
    const binaryArch = arch === 'x64' ? 'x86_64' : 'arm64'
    options.run('lipo', [executablePath, '-verify_arch', binaryArch])`)
    .replace(entries, 'for (const entry of MACOS_UNIVERSAL_NATIVE_ENTRIES.filter(entry => entry.arch === binaryArch))')
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
