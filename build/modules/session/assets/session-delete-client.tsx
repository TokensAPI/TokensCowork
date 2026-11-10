/**
 * TokensCowork product overlay: the "Delete" row of a Session's menu (the
 * "..." menu, which right-click on a Session row also opens) and its
 * confirmation dialog. Confirming first archives through upstream's own
 * stop-and-archive path, which also clears the Session when it is on screen,
 * then asks the Desktop Host to remove it for good. Cancelling sends nothing.
 */

import { useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

/** Locale namespace owned by this overlay. */
const NS = 'tokens.session-delete'
/** Must match TOKENS_SESSION_DELETE_PATH in tokens-session-delete.ts. */
const DELETE_PATH = '/tokens/session/delete'

const zh = {
  'menu.delete': '删除',
  'confirm.title': '删除会话？',
  'confirm.desc': '此操作将永久删除“{title}”及其全部记录，删除后无法恢复。',
  'confirm.untitled': '未命名会话',
  'confirm.running': '该会话仍有正在进行的工作，删除前会先停止。',
  'confirm.cancel': '取消',
  'confirm.action': '删除',
  'confirm.pending': '正在删除…',
  'confirm.close': '关闭',
  'error.failed': '删除失败：{reason}',
  'error.unavailable': '当前窗口不能删除会话。',
} as const

const en: Record<keyof typeof zh, string> = {
  'menu.delete': 'Delete',
  'confirm.title': 'Delete session?',
  'confirm.desc': 'This will permanently delete “{title}” and all of its history. This can’t be undone.',
  'confirm.untitled': 'Untitled session',
  'confirm.running': 'Work still in progress in this session will be stopped first.',
  'confirm.cancel': 'Cancel',
  'confirm.action': 'Delete',
  'confirm.pending': 'Deleting…',
  'confirm.close': 'Close',
  'error.failed': 'Couldn’t delete the session: {reason}',
  'error.unavailable': 'Sessions can’t be deleted from this window.',
}

type SessionDeleteKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Session menu's Delete row and its confirmation. */
    'tokens.session-delete': SessionDeleteKey
  }
}

/** The pending confirmation, or null while none is open. */
interface DeleteRequest {
  readonly sessionId: SessionId
  readonly displayTitle: string
  readonly running: boolean
}

interface DeleteMenuItemInjected {
  readonly requestDelete: (sessionId: SessionId, displayTitle: string) => void
}

type DeleteMenuItemProps =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<'tokens.session-delete'>
  & InjectFace<DeleteMenuItemInjected>

interface DeleteDialogInjected {
  readonly hooks: { readonly deleteRequest: ReturnType<typeof createSnapshotStore<DeleteRequest | null>> }
  readonly settle: () => void
  readonly confirmDelete: (sessionId: SessionId) => Promise<void>
}

type DeleteDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'tokens.session-delete'>
  & Omit<DeleteDialogInjected, 'hooks'>
  & PropsHooks<DeleteDialogInjected['hooks']>

/** Menu row: the last group of the Session menu, styled as destructive. */
function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }: DeleteMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      danger
      separatorBefore
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        requestDelete(sessionId, displayTitle)
      }}
    >
      {t('menu.delete')}
    </MenuItemButton>
  )
}

/** The `shell.overlay` entry: nothing until a deletion is requested. */
function DeleteSessionDialog({ useDeleteRequest, settle, confirmDelete, t }: DeleteDialogProps) {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return <DeleteConfirmForm key={request.sessionId} request={request} settle={settle} confirmDelete={confirmDelete} t={t} />
}

function DeleteConfirmForm({ request, settle, confirmDelete, t }: {
  request: DeleteRequest
  settle: () => void
  confirmDelete: DeleteDialogInjected['confirmDelete']
  t: DeleteDialogProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = (): void => {
    if (!deleting) settle()
  }
  const confirm = (): void => {
    setDeleting(true)
    setError(null)
    confirmDelete(request.sessionId).then(() => {
      setDeleting(false)
      settle()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(t('error.failed', { reason: reason instanceof Error ? reason.message : String(reason) }))
    })
  }
  const title = request.displayTitle === '' ? t('confirm.untitled') : request.displayTitle
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('confirm.close')}
      title={t('confirm.title')}
      description={t('confirm.desc', { title })}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>{t('confirm.cancel')}</Button>
          <Button
            variant="outline"
            disabled={deleting}
            onClick={confirm}
            style={deleting ? undefined : { color: 'var(--dsw-alias-state-error-primary)' }}
          >
            {t('confirm.action')}
          </Button>
        </>
      )}
    >
      {request.running && <p>{t('confirm.running')}</p>}
      {deleting && <div role="status">{t('confirm.pending')}</div>}
      {error !== null && <div role="alert" style={{ color: 'var(--dsw-alias-state-error-primary)' }}>{error}</div>}
    </Modal>
  )
}

/** Ask the Desktop Host to remove the Session; the body names the refusal when it has one. */
async function postDelete(sessionId: SessionId): Promise<void> {
  const response = await fetch(DELETE_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  if (response.ok) return
  let message = `HTTP ${String(response.status)}`
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') message = body.error
  } catch { /* keep the status line */ }
  throw new Error(message)
}

/**
 * Register the Delete row and its dialog. Called from the Desktop client
 * apply, which runs only inside a Desktop window: the route behind it accepts
 * this renderer's own origin only.
 * @param ctx - browser Cordis context of the Desktop client.
 */
export function applySessionDelete(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const deleteRequest = createSnapshotStore<DeleteRequest | null>(null, { flush: 'sync' })
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tokens: session delete dictionaries')

  const requestDelete: DeleteMenuItemInjected['requestDelete'] = (sessionId, displayTitle) => {
    const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
    deleteRequest.set({ sessionId, displayTitle, running: summary?.running === true })
  }

  ctx.inject(['uiWorkspace'], (scope: ClientContext) => {
    const confirmDelete: DeleteDialogInjected['confirmDelete'] = async (sessionId) => {
      const workspace = scope.get('uiWorkspace') as UiWorkspace | undefined
      if (workspace === undefined) throw new Error(t('error.unavailable'))
      // Upstream's own stop-and-archive: stops running work, blocks later
      // wakes, and clears the Session when it is the one on screen.
      await workspace.archiveSession(sessionId, { stopActivity: true })
      await postDelete(sessionId)
      await ctx.sessions.refresh()
    }
    scope.slots.inject('sidebar.workspaces.session.menu.item', () => scope.slots.register({
      name: 'sidebar.workspaces.session.menu.item',
      id: 'tokens-session-delete',
      order: 500,
      locale: NS,
      inject: () => ({ requestDelete }),
    }, DeleteSessionMenuItem))
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay',
      id: 'tokens.session-delete',
      locale: NS,
      inject: () => ({
        hooks: { deleteRequest },
        settle: () => { deleteRequest.set(null) },
        confirmDelete,
      }),
    }, DeleteSessionDialog))
  })
}
