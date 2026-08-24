import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const stage = resolve(root, '.build', 'desktop')
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
const unpackedResources = resolve(desktopRoot, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked')
const packagedMain = readFileSync(resolve(unpackedResources, 'lib', 'main.js'), 'utf8')
const packagedRuntimeClosure = readdirSync(resolve(unpackedResources, 'lib'), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
  .map(entry => readFileSync(resolve(unpackedResources, 'lib', entry.name), 'utf8'))
  .join('\n')
const packagedRuntimeFiles = readdirSync(unpackedResources, { recursive: true })
  .map(path => path.replaceAll('\\', '/'))
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
if (buildManifest.build?.appId !== product.appId
  || buildManifest.build?.productName !== product.name) {
  throw new Error('Windows build configuration branding differs from product.json')
}
// deleteAppDataOnUninstall 是编译期开关：一旦打进安装包，卸载时运行期传的
// /KEEP_APP_DATA 也救不回用户数据。产品约定卸载默认保留，故它必须不为真。
if (buildManifest.build?.nsis?.deleteAppDataOnUninstall === true) {
  throw new Error('Windows build configuration would delete user data on uninstall')
}
if (!packagedMain.includes(product.name) || !packagedMain.includes(product.appId)
  || packagedMain.includes('ai.deepseek.dsh.desktop')) {
  throw new Error('packaged Windows main runtime retains upstream identity')
}
if (!packagedRuntimeClosure.includes(product.name)
  || packagedRuntimeClosure.includes('DeepSeek Harness Desktop')) {
  throw new Error('packaged Windows desktop shell retains upstream window branding')
}
if (forbiddenMetadata.length !== 0) {
  throw new Error(`packaged Windows runtime retains non-runtime metadata: ${forbiddenMetadata[0]}`)
}
for (const path of requiredWindowsX64Runtime) {
  if (!existsSync(resolve(unpackedResources, path))) {
    throw new Error(`packaged Windows x64 runtime is missing required native files: ${path}`)
  }
}
for (const path of forbiddenForeignRuntime) {
  if (existsSync(resolve(unpackedResources, path))) {
    throw new Error(`packaged Windows x64 runtime retains a foreign native architecture: ${path}`)
  }
}
process.stdout.write(
  `verify-package: Windows ${product.name} ${product.version} installer passed `
  + `(${packagedRuntimeFiles.length} unpacked entries)\n`,
)
