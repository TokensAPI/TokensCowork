/** Verdaccio 6 local-storage import. Stop the registry before --apply.
 * Does not modify tarballs, accounts, secrets, access rules or uplinks config.
 * Usage: node import-cached-packages.mjs STORAGE ORIGIN NAME... [--apply]
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

export function preparePackage(root, origin, name) {
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(name)) throw Error('Expected explicit scoped package name')
  const file = path.join(root, name, 'package.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (data.name !== name) throw Error(`Package name mismatch: ${name}`)
  const versions = Object.entries(data.versions ?? {})
  if (!versions.length) throw Error(`No versions: ${name}`)
  for (const [version, manifest] of versions) {
    const filename = path.posix.basename(new URL(manifest.dist.tarball).pathname)
    if (!filename.endsWith('.tgz')) throw Error('Invalid tarball filename')
    const bytes = fs.readFileSync(path.join(root, name, filename))
    const sha1 = crypto.createHash('sha1').update(bytes).digest('hex')
    if (sha1 !== manifest.dist.shasum) throw Error(`Checksum mismatch: ${name}@${version}`)
    const integrity = manifest.dist.integrity
    if (integrity) {
      const tokens = integrity.split(/\s+/)
      const valid = tokens.some(token => {
        const match = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(token)
        return match && crypto.createHash(match[1]).update(bytes).digest('base64') === match[2]
      })
      if (!valid) throw Error(`Integrity mismatch: ${name}@${version}`)
    }
    data._attachments ??= {}
    data._attachments[filename] = { shasum: sha1, version }
    manifest.dist.tarball = `${origin}/${name}/-/${filename}`
  }
  for (const version of Object.values(data['dist-tags'] ?? {})) {
    if (!data.versions[version]) throw Error(`Tag references missing version: ${name}`)
  }
  data._uplinks = {}
  data._distfiles = {}
  // Local-storage updates revisions when subsequent registry writes occur.
  return { file, data, count: versions.length }
}

export function importPackages(root, origin, names, apply = false) {
  origin = new URL(origin).origin
  if (!names.length || new Set(names).size !== names.length) throw Error('Explicit unique names required')
  const plans = names.map(name => preparePackage(root, origin, name))
  const dbFile = path.join(root, '.verdaccio-db.json')
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
  if (!Array.isArray(db.list)) throw Error('Unsupported local database format')
  const result = { packages: names.length, versions: plans.reduce((n, p) => n + p.count, 0), applied: apply }
  if (!apply) return result
  const backup = path.join(root, '.import-backups', crypto.randomUUID())
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
  const files = [...plans.map(p => p.file), dbFile]
  files.forEach((file, i) => fs.copyFileSync(file, path.join(backup, `${i}.json`)))
  fs.writeFileSync(path.join(backup, 'files.json'), JSON.stringify(files))
  const replace = (file, data) => {
    const tmp = file + '.import-tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  try {
    for (const plan of plans) replace(plan.file, plan.data)
    db.list = [...new Set([...db.list, ...names])]
    replace(dbFile, db)
  } catch (error) {
    files.forEach((file, i) => fs.copyFileSync(path.join(backup, `${i}.json`), file))
    throw error
  }
  return { ...result, backup }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, origin, ...args] = process.argv.slice(2)
  console.log(JSON.stringify(importPackages(root, origin, args.filter(x => x !== '--apply'), args.includes('--apply'))))
}
