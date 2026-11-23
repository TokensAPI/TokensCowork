import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import UsersPage from './UsersPage.vue'
import OrganizationsPage from './OrganizationsPage.vue'
import ActivityPage from './ActivityPage.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { notify, toast } from '../feedback'
import { state, type Session } from '../session'
import { fakeMarket, settle, type Reply } from '../test-support'

const PLATFORM: Session = { authenticated: true, role: 'platform', organizationId: null, organizationName: null, userId: null }
const TENANT: Session = { authenticated: true, role: 'organization', organizationId: 101, organizationName: '测试组织', userId: '5001' }
const PLUGINS = [{ id: 'media-gen', displayName: '媒体生成', package: '@example/media-gen', state: 'published', visibility: 'restricted', category: 'optional' }]
const ORG_PLUGINS = [
  { id: 'media-gen', displayName: '媒体生成', package: '@example/media-gen', source: 'organization', switchable: true, enabled: true, visible: true, members: [{ id: 6002, name: '乙' }] },
  { id: 'open', displayName: '公开工具', package: '@example/open', source: 'public', switchable: false, enabled: true, visible: true, members: [] },
]

let wrapper: VueWrapper | undefined
function mountPage(page: object) {
  wrapper = mount({ render: () => [h(page), h(ConfirmDialog)] }, { attachTo: document.body })
  return wrapper
}
function market(override: (path: string, init: RequestInit) => Reply | undefined = () => undefined) {
  return fakeMarket((path, init) => {
    const answer = override(path, init)
    if (answer) return answer
    if (path === '/api/v1/users') return { body: { items: [{ id: 6002, name: '测试用户乙', plugins: ['media-gen'] }], searchReady: true } }
    if (path === '/api/v1/users/6002/plugins')
      return { body: { id: 6002, name: '测试用户乙', registered: true, organization: null, items: [{ id: 'media-gen', sources: [{ kind: 'user' }, { kind: 'organization', id: 101, name: '测试组织' }] }] } }
    if (path === '/api/v1/plugins?view=index') return { body: { items: PLUGINS } }
    if (path === '/api/v1/organizations') return { body: { items: [{ id: 101, name: '测试组织', enabled: true, granted: 1, hidden: 0 }], syncReady: false } }
    if (path === '/api/v1/organizations/101') return { body: { id: 101, name: '测试组织', enabled: true } }
    if (path === '/api/v1/organizations/101/plugins') return { body: { items: ORG_PLUGINS } }
    if (path === '/api/v1/keys') return { body: { items: [{ fingerprint: 'f'.repeat(64), label: '客户 Key', apiKey: null, plugins: [] }], displayReady: true } }
    if (path === '/api/v1/audit')
      return { body: { items: [
        { action: 'grants.updated', target: `key:${'f'.repeat(64)}`, actor: { kind: 'root', id: 'token' }, details: { pluginCount: 1, added: 1, removed: 0 }, createdAt: 1 },
        { action: 'tenant.plugin.updated', target: '101:media-gen', actor: { kind: 'tenant', id: '5001', organizationId: 101 }, details: { memberCount: 0 }, createdAt: 2 },
      ] } }
    return { body: { ok: true } }
  })
}

beforeEach(() => notify())
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  state.session = null
  vi.unstubAllGlobals()
})

describe('the users page', () => {
  beforeEach(() => (state.session = PLATFORM))
  it('lists users with what they really hold and where it comes from', async () => {
    market()
    const page = mountPage(UsersPage)
    await settle()
    const cells = page.findAll('tbody tr td').slice(0, 3).map((cell) => cell.text())
    expect(cells).toEqual(['测试用户乙', '6002', '媒体生成单独授权组织：测试组织'])
    expect(page.find('.card-footer').text()).toBe('共 1 个用户。添加时可从 TokensAPI 搜索。')
  })
  it('removes a user only after saying what goes with it', async () => {
    const { calls } = market()
    const page = mountPage(UsersPage)
    await settle()
    await page.find('button[aria-label="测试用户乙 (#6002) 移除"]').trigger('click')
    await settle()
    const confirm = page.find('dialog[aria-labelledby="confirm-title"]')
    expect(confirm.find('#confirm-text').text()).toBe('它的 1 项插件授权一并撤掉，对该用户名下所有 Key 生效。TokensAPI 里的账号、组织授权和单独登记的 Key 不受影响。')
    ;(confirm.element as HTMLDialogElement).close('ok')
    await settle()
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/api/v1/users/6002'])
    expect(toast.message).toBe('用户已移除。')
  })
})

describe('the organizations page', () => {
  it('an organization administrator sees its own organization only, with no directory and no way back to one', async () => {
    state.session = TENANT
    const { calls } = market()
    const page = mountPage(OrganizationsPage)
    await settle()
    expect(page.find('.page-title').text()).toBe('我的组织')
    expect(page.find('.card-title').text()).toBe('测试组织 (#101)')
    expect(page.text()).not.toContain('返回组织名录')
    expect(page.find('.page-header .btn').exists()).toBe(false)
    expect(calls.map((call) => call.path)).not.toContain('/api/v1/organizations')
    expect(page.findAll('tbody tr').map((row) => row.findAll('td')[2]!.text())).toEqual(['仅 1 位成员可见', '全员可见'])
  })
  it('clearing a plugin\'s members asks first, then saves an empty list', async () => {
    state.session = TENANT
    const { calls } = market()
    const page = mountPage(OrganizationsPage)
    await settle()
    await page.find('button[aria-label="媒体生成 指定成员"]').trigger('click')
    const dialog = page.find('dialog[aria-labelledby="members-title"]')
    expect(dialog.find('.modal-footer .text-secondary').text()).toBe('只有这 1 位成员可见')
    await dialog.find('.btn-list .btn').trigger('click')
    expect(dialog.find('.modal-footer .text-secondary').text()).toBe('本组织全员可见')
    await dialog.find('form').trigger('submit')
    await settle()
    const confirm = page.find('dialog[aria-labelledby="confirm-title"]')
    expect(confirm.find('#confirm-title').text()).toBe('清空「媒体生成」的可见成员？')
    ;(confirm.element as HTMLDialogElement).close('ok')
    await settle()
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([{ method: 'PUT', path: '/api/v1/organizations/101/plugins/media-gen', body: { members: [] } }])
    expect(toast.message).toBe('媒体生成 已恢复本组织全员可见。')
  })
  it('the platform administrator opens one organization from the directory and comes back', async () => {
    state.session = PLATFORM
    market()
    const page = mountPage(OrganizationsPage)
    await settle()
    expect(page.find('tbody tr td').text()).toBe('测试组织')
    await page.find('button[aria-label="测试组织 查看插件"]').trigger('click')
    await settle()
    expect(page.find('.card-title').text()).toBe('测试组织 (#101)')
    await page.find('.card-actions .btn').trigger('click')
    expect(page.find('.card-footer').text()).toBe('共 1 个组织。未配置 TokensAPI 组织名录，只能手动登记。')
  })
})

describe('the activity page', () => {
  it('names each change, what it was made to, its facts and who made it', async () => {
    state.session = PLATFORM
    market()
    const page = mountPage(ActivityPage)
    await settle()
    expect(page.findAll('tbody tr').map((row) => row.findAll('td').slice(0, 3).map((cell) => cell.text()))).toEqual([
      ['配置插件授权客户 Key', '共 1 个插件（新增 1，撤销 0）', '平台管理员 · 口令'],
      ['组织插件设置测试组织 (#101) · 媒体生成', '全员可见', '组织管理员 · 用户 5001 · 组织 #101'],
    ])
  })
})
