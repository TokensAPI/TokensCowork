/**
 * TokensCowork product overlay: permanent Session deletion, Host-side steps.
 *
 * Pure orchestration over injected Host capabilities, so the same code runs
 * inside the Desktop shell and under the product's outer tests and real-Host
 * smoke. Order is the safety argument:
 *   archive with stopActivity (durable, blocks every later wake) →
 *   wait until nothing runs → dispose the live Agent (stops the loop, closes
 *   the write handle, releases the lease) → prove no writer owns the log →
 *   remove the Session directory → only then forget the id in the registry.
 * Any refusal before the removal leaves the Session archived, never half
 * deleted; a repeated call after a crash finishes the registry cleanup.
 *
 * Only erasable TypeScript and type-only package imports are used here: Node's
 * type stripping loads this file directly in the outer tests and the real-Host
 * smoke (build/modules/session/staging-session-delete-smoke.mjs).
 */

import { readdir, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'

/** The header fields this deletion reads. */
export interface DeletableSessionHeader {
  readonly id: string
  readonly cwd?: string | undefined
  readonly parentSession?: string | undefined
  readonly origin?: 'subagent' | undefined
}

/** What releasing one live Agent reported. */
export type AgentReleaseResult = 'released' | 'absent' | 'unowned'

/** Host capabilities the deletion drives; the Desktop shell binds them to real services. */
export interface SessionDeleteHost {
  /** The JSONL backend's configured session root. */
  readonly root: string
  /** Every stored Session's header. */
  list(): Promise<readonly DeletableSessionHeader[]>
  /** One stored Session's header, or undefined when storage holds none. */
  stat(id: string): Promise<DeletableSessionHeader | undefined>
  /** The live Session's header, when one is attached in this process. */
  liveHeader(id: string): DeletableSessionHeader | undefined
  /** Archive durably and request every provider to stop the Session's work. */
  archive(id: string): Promise<void>
  /** What the composed providers still report as running for the Session. */
  activity(id: string): Promise<readonly unknown[]>
  /** Whether the Session's live Agent is running a turn. */
  running(id: string): boolean
  /** Whether a live Session or Agent with this id is still attached. */
  attached(id: string): boolean
  /** Dispose the live Agent through its retained handle. */
  release(id: string): Promise<AgentReleaseResult>
  /** Take and drop write ownership: rejects while any writer, in any process, holds the lease. */
  claimWriter(id: string): Promise<void>
  /** Names inside one directory; undefined when the directory does not exist. */
  entries(path: string): Promise<readonly string[] | undefined>
  /** Remove one directory tree. */
  removeDirectory(path: string): Promise<void>
  /** Drop the id from every Workspace, the pin set, and finally the archive set. */
  forget(id: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
  warn(message: string): void
}

/** Refusal codes the route maps to HTTP 409; any other failure is a Host fault. */
export type SessionDeleteRefusal = 'invalid-id' | 'subagent' | 'busy' | 'owned' | 'storage' | 'remove-failed'

/** A deletion the Host refused or could not finish; the Session stays archived unless the code says otherwise. */
export class SessionDeleteError extends Error {
  readonly code: SessionDeleteRefusal

  constructor(code: SessionDeleteRefusal, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SessionDeleteError'
    this.code = code
  }
}

export interface SessionDeleteOptions {
  /** How long running work may take to stop after the archive asked it to. */
  readonly stopTimeoutMs?: number
  readonly pollMs?: number
}

export interface SessionDeleteResult {
  /** Every Session id whose storage this call removed (the Session first, then its subagent descendants). */
  readonly deleted: readonly string[]
}

/** Longest id the route accepts; DSH ids are `session-<uuid>`. */
const MAX_ID_LENGTH = 256

/**
 * Same escaping as dsh-session-persistence-jsonl `encodeSegment` (DSH 0.2.1-rc.2).
 * @param raw - a non-empty string.
 * @returns one filesystem-safe path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Same project directory key as dsh-session-persistence-jsonl `projectKey` (DSH 0.2.1-rc.2).
 * @param cwd - the Session's project directory.
 * @returns one filesystem-safe project directory name.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/u, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * The directory the JSONL backend owns for one Session, checked to sit exactly
 * two levels below the root.
 * @param root - the backend's session root.
 * @param header - the Session's id and cwd.
 * @returns the absolute Session directory.
 */
export function sessionDirectory(root: string, header: DeletableSessionHeader): string {
  const base = resolve(root)
  const project = header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd)
  const directory = resolve(join(base, project, encodeSegment(header.id)))
  const parts = relative(base, directory).split(sep)
  if (parts.length !== 2 || parts.includes('..') || parts.some(part => part === '')) {
    throw new SessionDeleteError('storage', `session directory for "${header.id}" escapes the session root`)
  }
  return directory
}

/** The id the route accepts: what the JSONL backend could have written, nothing that reads as a path. */
export function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
    && !/[\\/\0]/u.test(value) && value !== '.' && value !== '..'
}

/** Subagent descendants of `id`, deepest first, from stored headers only. */
export function subagentDescendants(id: string, headers: readonly DeletableSessionHeader[]): string[] {
  const children = new Map<string, string[]>()
  for (const header of headers) {
    if (header.origin !== 'subagent' || header.parentSession === undefined) continue
    const list = children.get(header.parentSession) ?? []
    list.push(header.id)
    children.set(header.parentSession, list)
  }
  const ordered: string[] = []
  const seen = new Set<string>([id])
  const visit = (parent: string): void => {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      visit(child)
      ordered.push(child)
    }
  }
  visit(id)
  return ordered
}

/** A JSONL Session directory holds a `session*.jsonl*` log; anything else is not ours to remove. */
function looksLikeSessionDirectory(names: readonly string[]): boolean {
  return names.some(name => name.startsWith('session') && name.includes('.jsonl'))
}

/**
 * Permanently delete one top-level Session and its subagent descendants.
 * @param host - bound Host capabilities.
 * @param id - the Session to delete.
 * @param options - stop timeout and polling interval.
 * @returns the removed Session ids; empty when storage already held none (registry cleanup still ran).
 * @throws {SessionDeleteError} for refusals; the Session stays archived after the archive step.
 */
export async function deleteSession(
  host: SessionDeleteHost,
  id: string,
  options: SessionDeleteOptions = {},
): Promise<SessionDeleteResult> {
  if (!validSessionId(id)) throw new SessionDeleteError('invalid-id', 'invalid session id')
  const stopTimeoutMs = options.stopTimeoutMs ?? 15_000
  const pollMs = options.pollMs ?? 100

  const header = host.liveHeader(id) ?? await host.stat(id)
  if (header === undefined) {
    // Nothing stored: a repeated call after the removal, or an id that never
    // existed. Finishing the registry cleanup is the whole remaining job.
    await host.forget(id)
    return { deleted: [] }
  }
  if (header.origin === 'subagent') {
    throw new SessionDeleteError('subagent', 'a subagent session is deleted together with its parent session')
  }
  const stored = await host.list()
  const descendants = subagentDescendants(id, stored)
  const headers = new Map<string, DeletableSessionHeader>(stored.map(item => [item.id, item]))
  headers.set(id, header)
  // Children before the parent: a parent teardown must never find a live child.
  const targets = [...descendants, id]

  await host.archive(id)

  const deadline = host.now() + stopTimeoutMs
  for (;;) {
    const activity = await host.activity(id)
    const running = targets.some(target => host.running(target))
    if (activity.length === 0 && !running) break
    if (host.now() >= deadline) {
      throw new SessionDeleteError('busy', 'the session still has work in progress; it was archived and not deleted')
    }
    await host.sleep(pollMs)
  }

  for (const target of targets) {
    let released: AgentReleaseResult
    try {
      released = await host.release(target)
    } catch (error) {
      // Upstream teardown always leaves the registries before it reports a
      // failed final drain (e.g. a log already gone from disk); only a
      // still-attached Session is a reason to stop.
      if (host.attached(target)) {
        throw new SessionDeleteError('owned', `session "${target}" could not be released: ${String(error)}; it was archived and not deleted`, { cause: error })
      }
      host.warn(`session delete: releasing "${target}" reported a teardown failure after detaching: ${String(error)}`)
      released = 'released'
    }
    if (released === 'unowned' || host.attached(target)) {
      throw new SessionDeleteError('owned', `session "${target}" is still attached and could not be released; it was archived and not deleted`)
    }
  }

  const directories: [string, string][] = []
  for (const target of targets) {
    const targetHeader = headers.get(target)
    if (targetHeader === undefined || await host.stat(target) === undefined) continue
    try {
      await host.claimWriter(target)
    } catch (error) {
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        throw new SessionDeleteError('owned', `another writer still owns session "${target}"; it was archived and not deleted`, { cause: error })
      }
      // A log this backend cannot open for write (a historical or corrupt
      // generation) holds no writer we could have released either; the
      // in-process release above already proved this process owns nothing.
      host.warn(`session delete: write claim for "${target}" failed before removal: ${String(error)}`)
    }
    const directory = sessionDirectory(host.root, targetHeader)
    const names = await host.entries(directory)
    if (names === undefined) continue
    if (!looksLikeSessionDirectory(names)) {
      throw new SessionDeleteError('storage', `"${directory}" does not look like a session directory; nothing was removed`)
    }
    directories.push([target, directory])
  }

  const deleted: string[] = []
  for (const [target, directory] of directories) {
    try {
      await host.removeDirectory(directory)
    } catch (error) {
      throw new SessionDeleteError('remove-failed', `could not remove "${directory}": ${String(error)}`, { cause: error })
    }
    if (await host.stat(target) !== undefined) {
      throw new SessionDeleteError('remove-failed', `storage still lists session "${target}" after its directory was removed`)
    }
    deleted.push(target)
  }

  for (const target of targets) await host.forget(target)
  return { deleted: [...deleted].reverse() }
}

/** The registry method the product's dsh-agent overlay adds; absent when that overlay is missing. */
interface ReleasableAgents {
  tokensReleaseAgent?(id: SessionId): Promise<AgentReleaseResult>
}

interface HeaderFields {
  readonly id: string
  readonly cwd?: string | undefined
  readonly parentSession?: string | undefined
  readonly origin?: 'subagent' | undefined
}

function headerOf(header: HeaderFields): DeletableSessionHeader {
  return { id: String(header.id), cwd: header.cwd, parentSession: header.parentSession, origin: header.origin }
}

/**
 * Bind the deletion's Host capabilities to the live services.
 * @param ctx - scope holding the Workspace registry, Session persistence, Session store, and Agent registry.
 * @returns the bound capabilities.
 * @throws {SessionDeleteError} `storage` when the backend is not the JSONL one this deletion understands.
 */
export function bindSessionDeleteHost(ctx: Context): SessionDeleteHost {
  const persistence = ctx.sessionPersistence
  const configured = (persistence as unknown as { config?: { root?: unknown } }).config?.root
  if (typeof configured !== 'string' || configured === '') {
    throw new SessionDeleteError('storage', 'session storage is not the JSONL backend; deletion is unavailable')
  }
  const registry = ctx.workspaceRegistry
  const sid = (id: string): SessionId => id as SessionId
  return {
    root: resolve(configured),
    list: async () => (await persistence.list()).map(snapshot => headerOf(snapshot.header)),
    stat: async (id) => {
      const snapshot = await persistence.stat(sid(id))
      return snapshot === undefined ? undefined : headerOf(snapshot.header)
    },
    liveHeader: (id) => {
      const live = ctx.sessions.get(sid(id))
      return live === undefined ? undefined : headerOf(live.header)
    },
    archive: id => registry.archiveSession(sid(id), { stopActivity: true }),
    activity: id => ctx.waterfall('workspace/session-activity', { sessionId: sid(id) }, () => Promise.resolve([])),
    running: id => ctx.agents.get(sid(id))?.status === 'running',
    attached: id => ctx.sessions.get(sid(id)) !== undefined || ctx.agents.get(sid(id)) !== undefined,
    release: async (id) => {
      const agents = ctx.agents as unknown as ReleasableAgents
      if (agents.tokensReleaseAgent !== undefined) return agents.tokensReleaseAgent(sid(id))
      return ctx.agents.get(sid(id)) === undefined ? 'absent' : 'unowned'
    },
    claimWriter: async (id) => {
      const handle = await persistence.open(sid(id), 'write')
      await handle.close()
    },
    entries: async (path) => {
      try {
        return await readdir(path)
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') return undefined
        throw error
      }
    },
    // Windows: a search indexer or antivirus scan may hold a file briefly.
    removeDirectory: path => rm(path, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 }),
    forget: async (id) => {
      for (const workspace of registry.list()) await workspace.detachSession(sid(id))
      await registry.unpinSession(sid(id))
      // Last: the id leaves the archive set only after its storage is gone.
      await registry.unarchiveSession(sid(id))
    },
    sleep: async (ms) => { await delay(ms) },
    now: () => Date.now(),
    warn: (message) => { ctx.logger.warn(message) },
  }
}
