import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { RouterView, type Router } from 'vue-router'
import { createConsoleRouter } from '../router'
import { legacyHashHistory } from '../history'
import { state } from '../session'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { notify, toast } from '../feedback'
import { fakeMarket, settle } from '../test-support'

const SESSION = {
  id: 'session-abc', formatVersion: 4, title: '整理 README', client: { version: '0.7.8', platform: 'win32' }, parentSession: null,
  accountId: '5001', keyFingerprint: 'f'.repeat(64), keyLabel: null, key: 'sk-test-direct-0001', models: ['demo-model', 'demo-large'],
  tokens: { total: 56643, input: 56000, output: 643 }, eventCount: 3, storedBytes: 2048, tags: ['待跟进'], note: '看一下', createdAt: 1, lastReceivedAt: Date.now(),
}
const EVENTS = [
  { seq: 0, type: 'turn/start', time: 1000, data: { turn: 1 } },
  { seq: 1, type: 'user/message', time: 1001, data: { content: [{ type: 'text', text: '帮我看看项目' }], source: { kind: 'user' } } },
  { seq: 2, type: 'assistant/message', time: 1002, data: { step: 1, message: { content: [{ type: 'text', text: '这是 **回答**' }], source: { model: 'demo-model' } } } },
  { seq: 3, type: 'turn/end', time: 1003, data: { reason: { kind: 'completed' } } },
]

let router: Router | undefined
let wrapper: VueWrapper | undefined
function market(sessions = [SESSION]) {
  return fakeMarket((path, init) => {
    if (path.startsWith('/api/v1/session-logs?')) return { body: { items: sessions, total: sessions.length, page: 1, pageSize: 50, storedBytes: 2048, keyDisplayReady: true } }
    if (path === '/api/v1/session-logs/settings') return { body: { retentionDays: 30 } }
    if (path === '/api/v1/organizations') return { body: { items: [{ id: 101, name: '测试组织', enabled: true }], syncReady: true } }
    if (path.startsWith('/api/v1/users/names')) return { body: { items: [{ id: 5001, name: '测试用户甲', organization: { id: 101, name: '测试组织' } }] } }
    if (path.startsWith('/api/v1/session-logs/session-abc/4?')) return { body: { session: SESSION, keys: [{ key: SESSION.key, fingerprint: SESSION.keyFingerprint }], events: EVENTS, next: null } }
    if (init.method === 'DELETE') {
      sessions.splice(0)
      return { body: { ok: true } }
    }
    return { body: { ok: true } }
  })
}
async function start(hash: string) {
  history.replaceState(null, '', `/admin/next/${hash}`)
  router = createConsoleRouter(legacyHashHistory())
  wrapper = mount({ render: () => [h(RouterView), h(ConfirmDialog)] }, { global: { plugins: [router] }, attachTo: document.body })
  await router.isReady()
  await settle()
  return wrapper
}

beforeEach(() => {
  notify()
  state.session = { authenticated: true, role: 'platform', organizationId: null, organizationName: null, userId: null }
})
afterEach(() => {
  wrapper?.unmount()
  router?.options.history.destroy()
  wrapper = undefined
  router = undefined
  state.session = null
  vi.unstubAllGlobals()
})

describe('the session-log page', () => {
  it('lists sessions with the names, organizations, Key, models and totals, and the retention in its button', async () => {
    market()
    const page = await start('#session-logs')
    const cells = page.findAll('tbody tr td').map((cell) => cell.text())
    expect(cells.slice(1, 10)).toEqual([
      '整理 README0.7.8 · Windows', '测试用户甲ID 5001', '测试组织', 'sk-test…0001复制', 'demo-model+1', '5.7 万', '3 条 · 2 KB', '待跟进看一下', '刚刚',
    ])
    expect(page.find('.page-header .btn').text()).toBe('设置 · 保留天数：30 天')
    expect(page.find('[aria-live="polite"] .fw-medium').text()).toBe('共 1 个会话 · 2 KB')
  })

  it('an applied filter becomes a removable tag, and the list is asked for with it', async () => {
    const { calls } = market()
    const page = await start('#session-logs')
    await page.find('input[type="search"]').setValue('sk-test')
    await page.find('form').trigger('submit')
    await settle()
    expect(calls.at(-1)?.path).toBe('/api/v1/session-logs?key=sk-test&page=1&pageSize=50')
    expect(page.find('.tags-list .tag').text()).toBe('Key：sk-test')
    await page.find('.tags-list .btn-close').trigger('click')
    await settle()
    expect(calls.at(-1)?.path).toBe('/api/v1/session-logs?page=1&pageSize=50')
    expect(page.find('.tags-list').exists()).toBe(false)
  })

  it('opens a session at its own address and comes back to the list as it was', async () => {
    const { calls } = market()
    const page = await start('#session-logs')
    const listReads = () => calls.filter((call) => call.path.startsWith('/api/v1/session-logs?')).length
    await page.find('tbody tr .btn-link').trigger('click')
    await settle()
    expect(location.hash).toBe('#session-logs/session-abc/4')
    expect(page.find('.card-title').text()).toBe('整理 README')
    expect(page.find('.log-turn h3').text()).toBe('第 1 轮')
    expect(page.find('.log-md strong').text()).toBe('回答')
    const before = listReads()
    await page.find('button[title^="返回列表"]').trigger('click')
    await new Promise((done) => setTimeout(done, 30))
    await settle()
    expect(location.hash).toBe('#session-logs')
    expect(page.find('tbody tr').isVisible()).toBe(true)
    expect(listReads()).toBe(before)
  })

  it('a session address opens on its own, and leaving it loads the list', async () => {
    market()
    const page = await start('#session-logs/session-abc/4')
    expect(page.find('.card-title').text()).toBe('整理 README')
    await page.find('button[title^="返回列表"]').trigger('click')
    await settle()
    expect(location.hash).toBe('#session-logs')
    expect(page.findAll('tbody tr')).toHaveLength(1)
  })

  it('deletes a session only after the confirmation naming it', async () => {
    const { calls } = market()
    const page = await start('#session-logs')
    await page.find('button[aria-label="整理 README 删除"]').trigger('click')
    await settle()
    const confirm = page.find('dialog[aria-labelledby="confirm-title"]')
    expect(confirm.find('#confirm-text').text()).toBe('删除这个会话的全部日志（3 条事件）？')
    expect(confirm.find('.log-confirm-list').text()).toBe('整理 README · session-abc')
    ;(confirm.element as HTMLDialogElement).close('ok')
    await settle()
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/v1/session-logs/session-abc/4'])
    expect(toast.message).toBe('会话日志已删除。')
    expect(page.find('.empty-title').text()).toBe('暂无会话日志')
  })
})
