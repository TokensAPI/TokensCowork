import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import PluginsPage from './PluginsPage.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { notify, toast } from '../feedback'
import { state } from '../session'
import { fakeMarket, settle, type Reply } from '../test-support'

const COUNTS = { all: 3, builtin: 1, market: 2, published: 1, draft: 1, archived: 0, deleted: 0 }
const PLUGINS = [
  { id: 'core', displayName: '内置组件', package: '@example/core', state: 'builtin', category: 'builtin', visibility: 'public', version: '0.1.0', productVersion: '0.7.19', revision: 1 },
  { id: 'media-gen', displayName: '媒体生成', package: '@example/media-gen', state: 'published', category: 'optional', visibility: 'restricted', version: '0.3.0', npm: true, npmLatestVersion: '0.3.1', revision: 7, access: { organizations: [101, 103], keys: ['f'.repeat(64)], users: [] } },
  { id: 'draft-tool', displayName: '草稿工具', package: '@example/draft', state: 'draft', category: 'optional', visibility: 'public', version: '1.0.0', npm: false, revision: 2, access: { organizations: [], keys: [], users: [] } },
]
const ORGS = [{ id: 101, name: '测试组织', enabled: true }, { id: 103, name: '停用组织', enabled: false }]

let wrapper: VueWrapper | undefined
function market(override: (path: string, init: RequestInit) => Reply | undefined = () => undefined) {
  return fakeMarket((path, init) => {
    const answer = override(path, init)
    if (answer) return answer
    if (path.startsWith('/api/v1/plugins?')) return { body: { items: PLUGINS, total: 3, counts: COUNTS, page: 1, pageSize: 20 } }
    if (path === '/api/v1/organizations') return { body: { items: ORGS, syncReady: true } }
    if (path === '/api/v1/keys') return { body: { items: [{ fingerprint: 'f'.repeat(64), label: '客户 Key', apiKey: null, plugins: [] }], displayReady: true } }
    if (path === '/api/v1/users') return { body: { items: [], searchReady: true } }
    return { body: { ok: true } }
  })
}
async function mountPage() {
  wrapper = mount({ render: () => [h(PluginsPage), h(ConfirmDialog)] }, { attachTo: document.body })
  await settle()
  return wrapper
}

beforeEach(() => {
  notify()
  state.session = { authenticated: true, role: 'platform', organizationId: null, organizationName: null, userId: null, environment: {} }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  state.session = null
  vi.unstubAllGlobals()
})

describe('the plugin page', () => {
  it('shows the tabs with their counts and each plugin\'s version, state and scope', async () => {
    market()
    const page = await mountPage()
    expect(page.findAll('.nav-tabs .nav-link').map((tab) => tab.text())).toEqual(['全部3', '已上架1', '草稿1', '已下架0', '回收站0'])
    const rows = page.findAll('tbody tr').map((row) => row.findAll('td').slice(1, 4).map((cell) => cell.text()))
    expect(rows).toEqual([
      ['v0.1.0产品 0.7.19 内置', '内置', '所有人随应用安装，不可卸载'],
      ['v0.3.1自动跟随 npm latest', '已上架', '受限2 个组织 · 1 个 Key · 0 个用户1 个组织已停用'],
      ['v1.0.0固定版本', '草稿', '公开上架后所有人可见'],
    ])
    expect(page.findAll('tbody tr')[0]!.text()).toContain('由产品清单管理')
  })

  it('a tab asks the server for that stage, from page 1', async () => {
    const { calls } = market()
    const page = await mountPage()
    await page.findAll('.nav-tabs .nav-link')[2]!.trigger('click')
    await settle()
    expect(calls.at(-1)?.path).toBe('/api/v1/plugins?stage=draft&page=1&pageSize=20')
  })

  it('saves the access scope against the plugin\'s revision, and asks before dropping unsaved changes', async () => {
    const { calls } = market()
    const page = await mountPage()
    await page.find('button[aria-label="媒体生成 访问范围"]').trigger('click')
    const dialog = page.find('dialog[aria-labelledby="plugin-title"]')
    expect((dialog.element as HTMLDialogElement).open).toBe(true)
    expect(dialog.find('.modal-footer .fw-medium').text()).toBe('受限 · 2 个组织 · 1 个 Key · 0 个用户')
    await dialog.findAll('input[type="checkbox"]')[0]!.setValue(false)
    // Closing with a change asks first; keeping on editing leaves the dialog open.
    await dialog.find('.btn-close').trigger('click')
    await settle()
    const confirm = page.find('dialog[aria-labelledby="confirm-title"]')
    expect(confirm.find('#confirm-title').text()).toBe('放弃未保存的修改？')
    ;(confirm.element as HTMLDialogElement).close('cancel')
    await settle()
    expect((dialog.element as HTMLDialogElement).open).toBe(true)
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/api/v1/plugins/media-gen/access', body: { visibility: 'restricted', organizations: [103], keys: ['f'.repeat(64)], users: [], revision: 7 } },
    ])
    expect(toast.message).toBe('媒体生成 的访问范围已保存。')
  })

  it('purging needs the plugin\'s id typed out, and publishing a public plugin needs its box ticked', async () => {
    const { calls } = market()
    const page = await mountPage()
    await page.find('button[aria-label="草稿工具 上架"]').trigger('click')
    const dialog = page.find('dialog[aria-labelledby="lifecycle-title"]')
    expect(dialog.find('#lifecycle-title').text()).toBe('上架插件 · 草稿工具')
    expect(dialog.find('p.text-secondary').text()).toBe('此插件将对所有人公开。若仅给指定组织使用，请先取消并配置访问范围。')
    expect(dialog.find('input[type="checkbox"]').attributes('required')).toBeDefined()
    await dialog.find('input[type="checkbox"]').setValue(true)
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/v1/plugins/draft-tool/publish', body: { revision: 2, confirmPublic: true } }])
    expect(toast.message).toBe('上架插件成功。')
  })

  it('reads an npm package into a new plugin and keeps the id it suggested', async () => {
    market((path) =>
      path.startsWith('/api/v1/npm-package?')
        ? { body: { package: '@example/new', suggestedId: 'example-new', version: '1.2.0', displayName: '新插件', summary: '简介', repository: 'https://github.com/example/new', license: 'MIT', readmeSummary: 'README 里的简介' } }
        : undefined)
    const page = await mountPage()
    await page.find('.page-header .btn-primary').trigger('click')
    const dialog = page.find('dialog[aria-labelledby="catalog-title"]')
    await dialog.find('#catalog-package').setValue('https://www.npmjs.com/package/@example/new')
    await dialog.find('.input-group .btn').trigger('click')
    await settle()
    expect((dialog.find('#catalog-id').element as HTMLInputElement).value).toBe('example-new')
    expect((dialog.find('#catalog-name').element as HTMLInputElement).value).toBe('新插件')
    expect(dialog.find('output[role="alert"]').text()).toBe('已读取，可核对资料后保存草稿。npm 许可证：MIT。上架前仍须完成完整生产依赖许可证检查。下方提供 README 简介建议，可点击采用。')
    await dialog.find('.alert-secondary .btn').trigger('click')
    expect((dialog.find('#catalog-summary').element as HTMLTextAreaElement).value).toBe('README 里的简介')
  })
})
