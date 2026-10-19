import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { openPackagedTree } from './packaged-tree.mjs'

test('the directory layout lists only files and reads them from the application root', () => {
  const resources = mkdtempSync(join(tmpdir(), 'packaged-directory-'))
  try {
    mkdirSync(join(resources, 'app', 'lib'), { recursive: true })
    mkdirSync(join(resources, 'app', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64'), { recursive: true })
    writeFileSync(join(resources, 'app', 'lib', 'index.js'), 'runtime')
    writeFileSync(join(resources, 'app', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'pty.node'), '')
    const packaged = openPackagedTree(resources, () => { throw new Error('asar must not be loaded') })
    assert.equal(packaged.layout, 'directory')
    assert.deepEqual(packaged.files.sort(), [
      'lib/index.js',
      'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    ])
    assert.equal(packaged.read('lib/index.js'), 'runtime')
    // 原生文件就在应用树内，所以必需/禁止的原生路径按应用根判断。
    assert.equal(packaged.nativeRoot, resolve(resources, 'app'))
  } finally {
    rmSync(resources, { recursive: true, force: true })
  }
})

test('the asar layout reads through the archive and keeps the separate unpacked root', () => {
  const resources = mkdtempSync(join(tmpdir(), 'packaged-asar-'))
  try {
    writeFileSync(join(resources, 'app.asar'), '')
    const reads = []
    const packaged = openPackagedTree(resources, () => ({
      listPackage: () => ['\\lib\\index.js', 'node_modules\\x\\package.json'],
      extractFile: (archive, path) => { reads.push([archive, path]); return Buffer.from('archived') },
    }))
    assert.equal(packaged.layout, 'asar')
    assert.deepEqual(packaged.files, ['lib/index.js', 'node_modules/x/package.json'])
    assert.equal(packaged.read('lib/index.js'), 'archived')
    assert.deepEqual(reads, [[resolve(resources, 'app.asar'), `lib${sep}index.js`]])
    assert.equal(packaged.nativeRoot, resolve(resources, 'app.asar.unpacked'))
  } finally {
    rmSync(resources, { recursive: true, force: true })
  }
})

test('a packaging run that produced neither layout fails instead of passing empty', () => {
  const resources = mkdtempSync(join(tmpdir(), 'packaged-missing-'))
  try {
    assert.throws(() => openPackagedTree(resources, () => ({})), /packaged application tree not found/)
  } finally {
    rmSync(resources, { recursive: true, force: true })
  }
})
