import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import KeysPage, { type MarketKey } from './KeysPage.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ToastMessage from '../components/ToastMessage.vue'
import { notify, toast } from '../feedback'
import { fakeMarket, settle, type Reply } from '../test-support'

const PLUGINS = [
  { id: 'media-gen', displayName: '媒体生成', package: '@example/media-gen', state: 'published', visibility: 'restricted', category: 'optional' },
  { id: 'draft-tool', displayName: '草稿工具', package: '@example/draft', state: 'draft', visibility: 'restricted', category: 'optional' },
  { id: 'open-tool', displayName: '公开工具', package: '@example/open', state: 'published', visibility: 'public', category: 'optional' },
]
const key = (fields: Partial<MarketKey>): MarketKey => ({ fingerprint: 'f'.repeat(64), apiKey: null, label: '', plugins: [], ...fields })

/** A fake /api/v1 holding `keys`; `override` answers a request before the defaults do. */
function market(keys: MarketKey[], override: (path: string, init: RequestInit) => Reply | undefined = () => undefined) {
  return fakeMarket((path, init) => {
    const answer = override(path, init)
    if (answer) return answer
    if (path === '/api/v1/keys' && (init.method ?? 'GET') === 'GET') return { body: { items: keys, displayReady: true } }
    if (path === '/api/v1/plugins?view=index') return { body: { items: PLUGINS } }
    return { body: { ok: true } }
  })
}

let wrapper: VueWrapper | undefined
function mountPage() {
  wrapper = mount({ render: () => [h(KeysPage), h(ConfirmDialog), h(ToastMessage)] }, { attachTo: document.body })
  return wrapper
}
const rows = (page: VueWrapper) => page.findAll('tbody tr').map((row) => row.findAll('td').slice(0, 3).map((cell) => cell.text()))
const button = (page: VueWrapper, label: string) => page.find(`button[aria-label="${label}"]`)

beforeEach(() => notify())
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

describe('the Key page', () => {
  it('lists every Key: its note, its value or why there is none, and the plugins granted to it', async () => {
    market([
      key({ fingerprint: 'a'.repeat(64), label: '客户测试', apiKey: 'sk-test-a', plugins: ['media-gen', 'gone-plugin'] }),
      key({ fingerprint: 'b'.repeat(64) }),
    ])
    const page = mountPage()
    await settle()
    expect(rows(page)).toEqual([
      ['客户测试', 'sk-test-a', '媒体生成、gone-plugin'],
      ['未命名', '原文未保存，需删除后重新登记', '—'],
    ])
    expect(page.find('.card-footer').text()).toBe('共 2 个 Key。单独授权只对这个 Key 生效，与组织、用户授权互不影响。')
    // Copying is offered only where the value is kept; each row is named for assistive technology.
    expect(button(page, '客户测试 复制 Key').exists()).toBe(true)
    expect(button(page, '未命名 Key 复制 Key').exists()).toBe(false)
    expect(button(page, '未命名 Key 授权插件').exists()).toBe(true)
  })

  it('says when there is none yet', async () => {
    market([])
    const page = mountPage()
    await settle()
    expect(page.find('.empty-title').text()).toBe('暂无登记的 Key')
    expect(page.find('table').isVisible()).toBe(false)
  })

  it('registers a Key: sends the value and note once, closes, and reloads the list', async () => {
    const keys: MarketKey[] = []
    const { calls } = market(keys, (path, init) => {
      if (path === '/api/v1/keys' && init.method === 'POST') {
        keys.push(key({ fingerprint: 'c'.repeat(64), label: '新 Key', apiKey: 'sk-new' }))
        return { body: { ok: true, fingerprint: 'c'.repeat(64) } }
      }
    })
    const page = mountPage()
    await settle()
    await page.find('.page-header .btn-primary').trigger('click')
    const dialog = page.find('dialog[aria-labelledby="key-dialog-title"]')
    expect((dialog.element as HTMLDialogElement).open).toBe(true)
    expect(dialog.find('h2').text()).toBe('登记 Key')
    expect(dialog.find('.form-hint').text()).toBe('Key 原文加密保存')
    await dialog.find('#key-value').setValue('  sk-new  ')
    await dialog.find('#key-label').setValue(' 新 Key ')
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/v1/keys', body: { key: 'sk-new', label: '新 Key' } }])
    expect((dialog.element as HTMLDialogElement).open).toBe(false)
    expect(rows(page)).toEqual([['新 Key', 'sk-new', '—']])
    expect(toast).toMatchObject({ kind: 'success', message: 'Key 已登记，可点「授权插件」或在插件的「访问范围」里勾选。' })
  })

  it('shows a refused save in the dialog and the toast, and keeps the dialog open', async () => {
    market([], (path, init) => (init.method === 'POST' ? { status: 409, body: { error: '这个 Key 已登记' } } : undefined))
    const page = mountPage()
    await settle()
    await page.find('.page-header .btn-primary').trigger('click')
    const dialog = page.find('dialog[aria-labelledby="key-dialog-title"]')
    await dialog.find('#key-value').setValue('sk-dup')
    await dialog.find('form').trigger('submit')
    await settle()
    expect(dialog.find('output[role="alert"]').text()).toBe('这个 Key 已登记')
    expect(toast).toMatchObject({ kind: 'error', message: '这个 Key 已登记' })
    expect((dialog.element as HTMLDialogElement).open).toBe(true)
  })

  it('edits only the note of an existing Key', async () => {
    const existing = key({ fingerprint: 'd'.repeat(64), label: '旧备注', apiKey: 'sk-d' })
    const { calls } = market([existing])
    const page = mountPage()
    await settle()
    await button(page, '旧备注 改备注').trigger('click')
    const dialog = page.find('dialog[aria-labelledby="key-dialog-title"]')
    expect(dialog.find('h2').text()).toBe('修改备注')
    expect(dialog.find('#key-value').exists()).toBe(false)
    expect(dialog.find('.form-hint').text()).toBe('sk-d')
    await dialog.find('#key-label').setValue('新备注')
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([{ method: 'PATCH', path: `/api/v1/keys/${'d'.repeat(64)}`, body: { label: '新备注' } }])
    expect(toast.message).toBe('备注已保存。')
  })

  it('deletes only after the confirmation, which says what goes with it', async () => {
    const keys = [key({ fingerprint: 'e'.repeat(64), label: '要删的', plugins: ['media-gen', 'draft-tool'] })]
    const { calls } = market(keys, (path, init) => {
      if (init.method === 'DELETE') {
        keys.splice(0)
        return { body: { ok: true } }
      }
    })
    const page = mountPage()
    await settle()
    const confirm = page.find('dialog[aria-labelledby="confirm-title"]')

    await button(page, '要删的 删除').trigger('click')
    await settle()
    expect((confirm.element as HTMLDialogElement).open).toBe(true)
    expect(confirm.find('#confirm-title').text()).toBe('删除 Key「要删的」？')
    expect(confirm.find('#confirm-text').text()).toBe('它的 2 项插件授权一并移除，只授权给这个 Key 的受限插件，持有它的人将看不到。组织授权和用户授权不受影响；删除后不可恢复，需要时重新登记。')
    expect(confirm.find('button[value="ok"]').text()).toBe('删除 Key')
    // 取消 has the focus, and cancelling sends nothing.
    expect(document.activeElement).toBe(confirm.find('button[value="cancel"]').element)
    ;(confirm.element as HTMLDialogElement).returnValue = 'cancel'
    ;(confirm.element as HTMLDialogElement).close()
    await settle()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)

    await button(page, '要删的 删除').trigger('click')
    await settle()
    ;(confirm.element as HTMLDialogElement).close('ok')
    await settle()
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([{ method: 'DELETE', path: `/api/v1/keys/${'e'.repeat(64)}`, body: undefined }])
    expect(toast.message).toBe('Key 已删除。')
    expect(page.find('.empty-title').text()).toBe('暂无登记的 Key')
  })

  it('a failed list read says so and offers a retry', async () => {
    let fail = true
    market([key({ label: '在的' })], (path) => (fail && path === '/api/v1/keys' ? { status: 503, body: { error: '市场服务未配置' } } : undefined))
    const page = mountPage()
    await settle()
    expect(page.find('[role="alert"] .empty-subtitle').text()).toBe('市场服务未配置')
    fail = false
    await page.find('.empty-action button').trigger('click')
    await settle()
    expect(rows(page)).toEqual([['在的', '原文未保存，需删除后重新登记', '—']])
  })

  it('grants plugins: restricted ones only, ticked from what the Key holds, saved as a whole', async () => {
    const fp = 'a'.repeat(64)
    const { calls } = market([key({ fingerprint: fp, label: '客户', plugins: ['media-gen'] })], (path, init) => {
      if (path === `/api/v1/keys/${fp}/grants` && init.method === 'GET') return { body: { plugins: ['media-gen', 'open-tool'] } }
    })
    const page = mountPage()
    await settle()
    await button(page, '客户 授权插件').trigger('click')
    await settle()
    const dialog = page.find('dialog[aria-labelledby="grants-title"]')
    expect((dialog.element as HTMLDialogElement).open).toBe(true)
    expect(dialog.find('#grants-title').text()).toBe('客户')
    expect(dialog.findAll('label.list-group-item').map((item) => item.text())).toEqual(['媒体生成', '草稿工具未上架'])
    expect(dialog.find('.modal-footer .text-secondary').text()).toBe('已选 1 个插件')
    await dialog.findAll('input[type="checkbox"]')[1]!.setValue(true)
    expect(dialog.find('.modal-footer .text-secondary').text()).toBe('已选 2 个插件')
    await dialog.find('form').trigger('submit')
    await settle()
    // The public plugin it already held is kept, untouched.
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([{ method: 'PUT', path: `/api/v1/keys/${fp}/grants`, body: { plugins: ['media-gen', 'open-tool', 'draft-tool'] } }])
    expect(toast.message).toBe('客户 的插件授权已保存。')
  })
})
