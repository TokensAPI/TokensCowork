/**
 * Object storage for raw session-log batches. The worker only ever sees the four-method
 * contract below, so moving the archive from the data volume to an S3-compatible bucket
 * (Aliyun OSS and the like) is a configuration change, never a change to the business code:
 *
 *   put(key, bytes)   -> stores the bytes under key, replacing any earlier object
 *   get(key)          -> Uint8Array, or null when there is no such object
 *   delete(key)       -> removes the object; a missing object is not an error
 *   list(prefix)      -> every key that starts with prefix, sorted
 *
 * Keys are relative POSIX-style paths such as
 * `session-logs/2026/10/session-…/4/-1-120.json.gz`; anything else is refused.
 */
import { mkdirSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { createD1Database } from './adapters.mjs'

const KEY = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u
const PREFIX = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]*$/u
const safeKey = key => typeof key === 'string' && key.length <= 512 && KEY.test(key) && !key.split('/').some(part => part === '.' || part === '..')

/** Objects as files under one directory of the data volume. */
export function createLocalObjectStore(dir) {
  mkdirSync(dir, { recursive: true })
  const path = key => {
    if (!safeKey(key)) throw new Error('Invalid object key')
    return resolve(dir, ...key.split('/'))
  }
  async function walk(folder) {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    const found = []
    for (const entry of entries) {
      const full = resolve(folder, entry.name)
      if (entry.isDirectory()) found.push(...await walk(full))
      else if (entry.isFile() && !entry.name.endsWith('.part')) found.push(relative(dir, full).split(sep).join('/'))
    }
    return found
  }
  return {
    async put(key, bytes) {
      const target = path(key)
      await mkdir(dirname(target), { recursive: true })
      // Write aside and rename, so a reader never sees half an object.
      const temporary = `${target}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`
      try {
        await writeFile(temporary, bytes)
        await rename(temporary, target)
      } catch (error) { await unlink(temporary).catch(() => {}); throw error }
    },
    async get(key) {
      try { return new Uint8Array(await readFile(path(key))) } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
    },
    async delete(key) {
      const target = path(key)
      await rm(target, { force: true })
      // Drop the now-empty folders up to the store root; they would otherwise pile up one per session.
      for (let folder = dirname(target); folder.startsWith(dir + sep); folder = dirname(folder)) {
        if ((await readdir(folder).catch(() => ['?'])).length) break
        await rmdir(folder).catch(() => {})
      }
    },
    async list(prefix) {
      if (typeof prefix !== 'string' || !PREFIX.test(prefix)) throw new Error('Invalid object prefix')
      // Only the folder the prefix names is walked, not the whole store.
      const folder = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : ''
      const keys = await walk(folder ? resolve(dir, ...folder.split('/')) : dir)
      return keys.filter(key => key.startsWith(prefix)).sort()
    },
  }
}

/**
 * S3-compatible object storage (Aliyun OSS, AWS S3, MinIO …). Not implemented yet: configuring
 * it fails the start-up instead of silently falling back to the data volume. The configuration it
 * will read is fixed here so the switch stays a .env change.
 */
export function createS3ObjectStore(config) {
  const missing = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].filter(name => !config?.[name])
  if (missing.length) throw new Error(`S3 session-log storage needs ${missing.join(', ')}`)
  throw new Error('S3-compatible session-log storage is not implemented yet; use MARKET_SESSION_LOG_STORAGE=local')
}

/**
 * The two session-log bindings from the process environment: the object store for raw batches
 * and the index, a SQLite file of its own so it is backed up, cleaned and moved independently of
 * market.sqlite. MARKET_SESSION_LOG_STORAGE=off leaves the feature unconfigured (the upload
 * endpoint and console pages then answer 503).
 */
export function createSessionLogBindings(environment, dataDir, migrationsDir) {
  const storage = (environment.MARKET_SESSION_LOG_STORAGE || 'local').toLowerCase()
  if (storage === 'off') return {}
  const dir = environment.MARKET_SESSION_LOG_DIR || resolve(dataDir, 'session-logs')
  mkdirSync(dir, { recursive: true })
  let store
  if (storage === 'local') store = createLocalObjectStore(resolve(dir, 'objects'))
  else if (storage === 's3') store = createS3ObjectStore({
    endpoint: environment.MARKET_SESSION_LOG_S3_ENDPOINT,
    region: environment.MARKET_SESSION_LOG_S3_REGION,
    bucket: environment.MARKET_SESSION_LOG_S3_BUCKET,
    accessKeyId: environment.MARKET_SESSION_LOG_S3_ACCESS_KEY_ID,
    secretAccessKey: environment.MARKET_SESSION_LOG_S3_SECRET_ACCESS_KEY,
  })
  else throw new Error('MARKET_SESSION_LOG_STORAGE must be local, s3 or off')
  return {
    MARKET_SESSION_LOG_DB: createD1Database(resolve(dir, 'index.sqlite'), migrationsDir),
    MARKET_SESSION_LOG_STORE: store,
  }
}
