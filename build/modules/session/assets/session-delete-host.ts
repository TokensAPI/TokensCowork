/**
 * TokensCowork product overlay: the private Desktop route that permanently
 * deletes one Session. It is reachable only from this Desktop's own renderer.
 * Every request passes the Host connection's own rejection first, then the
 * same loopback + exact-Origin guard as Desktop's Profile deletion, so LAN
 * HTTPS, remote control, and ordinary browser peers are refused.
 * The steps and their Host binding live in tokens-session-delete-core.ts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  bindSessionDeleteHost,
  deleteSession,
  SessionDeleteError,
  validSessionId,
} from './tokens-session-delete-core.ts'
import { finishPrivateDesktopJson, readPrivateDesktopJson } from './desktop-settings-route.ts'

/** The private route path; the client half posts here. */
export const TOKENS_SESSION_DELETE_PATH = '/tokens/session/delete'

/** One deletion at a time: every step assumes no other deletion interleaves. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Register the private deletion route once the Session services are present.
 * @param ctx - the Desktop shell's Host context.
 * @param rendererOrigin - the Desktop renderer's exact loopback origin.
 * @param reject - the shell's connection-level request rejection.
 */
export function installSessionDelete(
  ctx: Context,
  rendererOrigin: string,
  reject: (ctx: Context, req: IncomingMessage, res: ServerResponse) => boolean,
): void {
  ctx.inject(['workspaceRegistry', 'sessionPersistence', 'sessions', 'agents'], (scope: Context) => {
    scope.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: TOKENS_SESSION_DELETE_PATH,
      handler: async (req, res) => {
        if (reject(ctx, req, res)) return
        const body = await readPrivateDesktopJson(req, res, rendererOrigin)
        if (body === undefined) return
        const sessionId = typeof body === 'object' && body !== null && !Array.isArray(body)
          && Object.keys(body).length === 1 ? (body as { sessionId?: unknown }).sessionId : undefined
        if (!validSessionId(sessionId)) {
          finishPrivateDesktopJson(res, 400, { error: 'invalid session deletion request' })
          return
        }
        const run = queue.then(() => deleteSession(bindSessionDeleteHost(scope), sessionId))
        queue = run.catch(() => undefined)
        try {
          finishPrivateDesktopJson(res, 200, await run)
        } catch (error) {
          if (error instanceof SessionDeleteError) {
            scope.logger.warn(`session delete refused for "${sessionId}" (${error.code}): ${error.message}`)
            finishPrivateDesktopJson(res, 409, { error: error.message, code: error.code })
            return
          }
          scope.logger.error(`session delete failed for "${sessionId}": ${String(error)}`)
          finishPrivateDesktopJson(res, 500, { error: 'session could not be deleted' })
        }
      },
    }), 'tokens: private session delete route')
  })
}
