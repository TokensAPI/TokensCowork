import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
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
process.stdout.write(`verify-package: Windows ${product.name} ${product.version} installer passed\n`)
