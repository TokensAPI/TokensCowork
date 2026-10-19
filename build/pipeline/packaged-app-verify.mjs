import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { alignConnectionRpcScope } from '../modules/runtime/runtime-version-overlay.mjs'
import { alignCompactionSummary } from '../modules/runtime/compaction-overlay.mjs'
import { verifyDesktopCertificateBranding } from '../modules/branding/branding-overlay.mjs'
import { openPackagedTree } from './packaged-tree.mjs'
import { productStage } from './paths.mjs'

const root = resolve(import.meta.dirname, '..', '..')
const stage = productStage(root)
const desktopRoot = resolve(stage, 'dsh-plugin-desktop')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8')).product
const mode = process.argv[2]

function assertPortableExecutable(path, label) {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size < 68) throw new Error(`${label} is not a non-empty file: ${path}`)
  const descriptor = openSync(path, 'r')
  const dosHeader = Buffer.alloc(64)
  try {
    if (readSync(descriptor, dosHeader, 0, dosHeader.byteLength, 0) !== dosHeader.byteLength
      || dosHeader.subarray(0, 2).toString('ascii') !== 'MZ') {
      throw new Error(`${label} has no Windows PE header: ${path}`)
    }
    const peOffset = dosHeader.readUInt32LE(0x3c)
    const signature = Buffer.alloc(4)
    if (peOffset > stat.size - 4
      || readSync(descriptor, signature, 0, signature.byteLength, peOffset) !== signature.byteLength
      || !signature.equals(Buffer.from('PE\0\0'))) {
      throw new Error(`${label} has no Windows PE signature: ${path}`)
    }
  } finally {
    closeSync(descriptor)
  }
}

if (mode !== 'windows') throw new Error('verify-package: expected windows')
const installer = resolve(desktopRoot, 'dist', `${product.name}-${product.version}-x64-Setup.exe`)
const executable = resolve(desktopRoot, 'dist', 'win-unpacked', `${product.name}.exe`)
assertPortableExecutable(installer, 'Windows NSIS installer')
assertPortableExecutable(executable, 'unpacked Windows application')
const buildManifest = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
if (buildManifest.description !== `${product.name} desktop application`) {
  throw new Error('Windows shortcut/application description retains incorrect branding')
}
const requireFromDesktop = createRequire(resolve(desktopRoot, 'package.json'))
// 上游 2.0.17 起 build.asar = false，应用按目录铺开；两种布局都要能校验。
const packaged = openPackagedTree(
  resolve(desktopRoot, 'dist', 'win-unpacked', 'resources'),
  () => requireFromDesktop('@electron/asar'),
)
const packagedRuntimeClosure = packaged.files
  .filter(path => path.startsWith('lib/') && path.endsWith('.js'))
  .map(path => packaged.read(path))
  .join('\n')
// 目录布局下原生文件就在应用树内，没有单独的解包清单。
const unpackedRuntimeFiles = packaged.layout === 'asar'
  ? readdirSync(packaged.nativeRoot, { recursive: true }).map(path => String(path).replaceAll('\\', '/'))
  : []
const packagedRuntimeFiles = [...new Set([...packaged.files, ...unpackedRuntimeFiles])]
const packagedNodeModuleFiles = packagedRuntimeFiles
  .filter(path => path.startsWith('node_modules/'))
const forbiddenMetadata = packagedNodeModuleFiles.filter(path => path.endsWith('.map')
  || path.endsWith('.d.ts')
  || path.endsWith('.d.mts')
  || path.endsWith('.d.cts'))
const requiredWindowsX64Runtime = [
  'node_modules/@img/sharp-win32-x64',
  'node_modules/@koromix/koffi-win32-x64',
  'node_modules/@vscode/ripgrep-win32-x64',
  'node_modules/node-addon-require-builtin-win32-x64-msvc',
  'node_modules/node-pty/prebuilds/win32-x64',
]
const forbiddenForeignRuntime = [
  'node_modules/@img/sharp-win32-arm64',
  'node_modules/@img/sharp-win32-ia32',
  'node_modules/@koromix/koffi-win32-arm64',
  'node_modules/@koromix/koffi-win32-ia32',
  'node_modules/@vscode/ripgrep-win32-arm64',
  'node_modules/@vscode/ripgrep-win32-ia32',
  'node_modules/node-addon-require-builtin-win32-arm64-msvc',
  'node_modules/node-addon-require-builtin-win32-ia32-msvc',
  'node_modules/node-pty/prebuilds/darwin-arm64',
  'node_modules/node-pty/prebuilds/darwin-x64',
  'node_modules/node-pty/prebuilds/linux-arm64',
  'node_modules/node-pty/prebuilds/linux-x64',
  'node_modules/node-pty/prebuilds/win32-arm64',
  'node_modules/node-pty/prebuilds/win32-ia32',
]
// DSH 0.2 uses the declarative preset registry. Validate its packaged identity;
// Loader/profile and upstream closure gates verify tree activation and exports.
const packagedPresetRegistry = JSON.parse(
  packaged.read('node_modules/@deepseek-ai/dsh-agent-preset-registry/package.json'))
if (packagedPresetRegistry.name !== '@deepseek-ai/dsh-agent-preset-registry'
  || packagedPresetRegistry.version !== JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8')).desktop.runtimeVersion) {
  throw new Error('Packaged preset registry differs from product runtime pin')
}
const packagedConnection = packaged.read('node_modules/@deepseek-ai/dsh-client-connection/lib/index.js')
if (alignConnectionRpcScope(packagedConnection) !== packagedConnection) {
  throw new Error('Packaged Connection is missing the RPC scope compatibility fix')
}
const packagedCompaction = packaged.read('node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js')
if (alignCompactionSummary(packagedCompaction) !== packagedCompaction) {
  throw new Error('Packaged compaction is missing checkpoint isolation and validation')
}
if (buildManifest.build?.appId !== product.appId
  || buildManifest.build?.productName !== product.name) {
  throw new Error('Windows build configuration branding differs from product.json')
}
if (buildManifest.build?.nsis?.guid !== product.windowsInstallerGuid) {
  throw new Error('Windows installer upgrade identity differs from product.json')
}
// deleteAppDataOnUninstall 是编译期开关：一旦打进安装包，卸载时运行期传的
// /KEEP_APP_DATA 也救不回用户数据。产品约定卸载默认保留，故它必须不为真。
if (buildManifest.build?.nsis?.deleteAppDataOnUninstall === true) {
  throw new Error('Windows build configuration would delete user data on uninstall')
}
// Certificate setup is dynamically imported in 0.5.0; validate all packaged
// runtime chunks, retaining both the required brand and forbidden-brand checks.
verifyDesktopCertificateBranding(packagedRuntimeClosure, product.name)
if (!packagedRuntimeClosure.includes(product.name)
  || !packagedRuntimeClosure.includes(product.appId)
  || packagedRuntimeClosure.includes('"ai.deepseek.dsh.desktop"')
  || packagedRuntimeClosure.includes('DeepSeek Harness Desktop')) {
  throw new Error('packaged Windows desktop runtime retains upstream identity')
}
if (forbiddenMetadata.length !== 0) {
  throw new Error(`packaged Windows runtime retains non-runtime metadata: ${forbiddenMetadata[0]}`)
}
// NSIS 的 nsisunz.dll 不支持 UTF-8 zip 条目：产物中任何非 ASCII 文件名
// 都会在用户安装时按 OEM 代码页乱解，报 Failed to decompress files
//（v0.3.7 事故：web-search 插件携带中文名 .cmd）。在此失败关闭。
const nonAsciiRuntimeFiles = packagedRuntimeFiles.filter(path => [...path].some(ch => ch.charCodeAt(0) > 127))
if (nonAsciiRuntimeFiles.length !== 0) {
  throw new Error(`packaged Windows runtime contains non-ASCII file names the installer cannot extract: ${nonAsciiRuntimeFiles[0]}`)
}
for (const path of requiredWindowsX64Runtime) {
  if (!existsSync(resolve(packaged.nativeRoot, path))) {
    throw new Error(`packaged Windows x64 runtime is missing required native files: ${path}`)
  }
}
for (const path of forbiddenForeignRuntime) {
  if (existsSync(resolve(packaged.nativeRoot, path))) {
    throw new Error(`packaged Windows x64 runtime retains a foreign native architecture: ${path}`)
  }
}
process.stdout.write(
  `verify-package: Windows ${product.name} ${product.version} installer passed `
  + `(${packaged.layout} layout, ${packaged.files.length} application entries, `
  + `${unpackedRuntimeFiles.length} unpacked entries)\n`,
)
