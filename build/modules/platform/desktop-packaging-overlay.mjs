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
  desktopPackage.build.appId = product.appId
  desktopPackage.build.productName = product.name
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
  return releaseMac.replace(upstreamReleaseCheck,
    '  // TokensCowork product assembly owns the release quality gates before packaging.\n')
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
