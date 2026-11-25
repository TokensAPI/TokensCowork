import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import { RouterView, type Router } from 'vue-router'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ToastMessage from '../components/ToastMessage.vue'
import { notify, toast } from '../feedback'
import { legacyHashHistory } from '../history'
import { createConsoleRouter } from '../router'
import { state } from '../session'
import { fakeMarket, settle, type Reply } from '../test-support'
import { scopeText, type AppRelease } from '../appReleases'

const ORGS = [
  { id: 101, name: '北辰研发', enabled: true },
  { id: 102, name: '澄海设计', enabled: true },
]
const release = (fields: Partial<AppRelease>): AppRelease => ({
  version: '0.8.0', status: 'draft', percent: 0, note: '', early: [], hold: [], earlyUsers: [], holdUsers: [], offered: 0, upgraded: 0, createdAt: 1, updatedAt: 1, ...fields,
})
const INSTALLS = { days: 7, total: 40, versions: [{ version: '0.8.0', count: 10 }, { version: '0.7.19', count: 30 }] }
const BRIEFS = [
  { version: '0.8.0', prerelease: true, publishedAt: '2026-11-25T00:00:00Z', summary: '更新提醒不再每次弹窗。' },
  { version: '0.7.19', prerelease: false, publishedAt: '2026-11-21T00:00:00Z', summary: '修复长对话被截断。' },
]
const INFO = {
  ...BRIEFS[0], name: 'TokensCowork v0.8.0', url: 'https://github.com/TokensAPI/TokensCowork/releases/tag/v0.8.0',
  highlights: [{ title: '新功能', items: ['一', '二', '三', '四'] }, { title: '问题修复', items: ['五', '六', '七'] }],
  components: [{ name: 'Desktop', version: '2.1.0' }],
  installers: [{ name: 'TokensCowork-0.8.0-windows-amd64-installer.exe', size: 271_000_000, url: 'https://github.com/TokensAPI/TokensCowork/releases/download/v0.8.0/a.exe' }],
}

function market(items: AppRelease[], override: (path: string, init: RequestInit) => Reply | undefined = () => undefined) {
  return fakeMarket((path, init) => {
    const answer = override(path, init)
    if (answer) return answer
    const method = init.method ?? 'GET'
    if (path === '/api/v1/app-releases' && method === 'GET') return { body: { items, installations: INSTALLS } }
    if (path === '/api/v1/organizations') return { body: { items: ORGS, syncReady: true } }
    if (path === '/api/v1/users') return { body: { items: [], searchReady: true } }
    if (path === '/api/v1/app-releases/info') return { body: { items: BRIEFS } }
    if (path === '/api/v1/app-releases/0.8.0/info') return { body: INFO }
    if (path.endsWith('/info')) return { status: 404, body: { error: 'GitHub 发布列表里没有这个版本' } }
    if (path.startsWith('/api/v1/users/search')) return { body: { items: [{ id: 5002, name: '林晚', username: 'linwan' }] } }
    if (path === '/api/v1/app-releases/available') return { body: { items: BRIEFS.map(({ summary: _summary, ...rest }) => rest) } }
    return { body: { ok: true } }
  })
}

let wrapper: VueWrapper | undefined
let router: Router
async function start(hash = '#app-releases') {
  history.replaceState(null, '', `/admin/${hash}`)
  router = createConsoleRouter(legacyHashHistory())
  wrapper = mount({ render: () => [h(RouterView), h(ConfirmDialog), h(ToastMessage)] }, { global: { plugins: [router] }, attachTo: document.body })
  await router.isReady()
  await settle()
  return wrapper
}
const rows = (page: VueWrapper) => page.findAll('tbody tr.release-row').map((row) => row.findAll('td').slice(0, 3).map((cell) => cell.text().replace(/\s+/gu, ' ')))
const byText = (page: VueWrapper, selector: string, text: string) => page.findAll(selector).find((node) => node.text() === text)!
const confirmDialog = (page: VueWrapper) => page.find('dialog[aria-labelledby="confirm-title"]')
const answer = async (page: VueWrapper, value: 'ok' | '') => {
  ;(confirmDialog(page).element as HTMLDialogElement).close(value)
  await settle()
}
const patches = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((call) => call.method === 'PATCH')

beforeEach(() => {
  notify()
  state.session = { role: 'platform', csrfToken: 't' } as never
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  state.session = null
  vi.unstubAllGlobals()
})

describe('who a rollout reaches, in plain words', () => {
  it('names the lists and the percentage, and says when nobody or everybody receives it', () => {
    const users = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]
    expect(scopeText(release({}))).toBe('还没有人能收到')
    expect(scopeText(release({ status: 'paused', percent: 30 }))).toBe('已暂停，不再提供给任何人')
    expect(scopeText(release({ status: 'rolling', percent: 20 }))).toBe('其余 20%')
    expect(scopeText(release({ status: 'rolling', percent: 20, early: [101], earlyUsers: users, hold: [102] }))).toBe('先发：1 个组织、2 个用户 · 其余 20% · 暂缓：1 个组织')
    expect(scopeText(release({ status: 'full', percent: 100, holdUsers: users }))).toBe('所有人 · 暂缓：2 个用户')
    expect(scopeText(release({ status: 'full', percent: 100 }))).toBe('所有人')
  })
})

describe('the 版本发布 list', () => {
  it('shows which release each version is, who receives it, and the counts', async () => {
    market([
      release({ version: '0.9.0', note: '下一版' }),
      release({ status: 'rolling', percent: 10, early: [101], hold: [102], holdUsers: [{ id: 7, name: '周' }], offered: 5, upgraded: 1 }),
    ])
    const page = await start()
    expect(rows(page)).toEqual([
      ['0.9.0备注：下一版', '草稿还没有人能收到', '0 / 0'],
      ['0.8.0预发布2026-11-25更新提醒不再每次弹窗。', '发布中先发：1 个组织 · 其余 10% · 暂缓：1 个组织、1 个用户', '5 / 1'],
    ])
    expect(page.findAll('.install-row').map((row) => row.text())).toEqual(['0.8.010 台 · 25%', '0.7.1930 台 · 75%'])
  })

  it('still lists the versions when GitHub cannot be read', async () => {
    market([release({ status: 'full', percent: 100 })], (path) => (path === '/api/v1/app-releases/info' ? { status: 503, body: { error: '读不到' } } : undefined))
    const page = await start()
    expect(rows(page)).toEqual([['0.8.0', '全量所有人', '0 / 0']])
  })

  it('creates a draft from the GitHub release list and opens it', async () => {
    const { calls } = market([release({ version: '0.8.0' })])
    const page = await start()
    await page.find('.page-header .btn-primary').trigger('click')
    await settle()
    const dialog = page.find('dialog[aria-labelledby="release-create-title"]')
    expect(dialog.findAll('#release-choice option').map((o) => o.text())).toEqual(['0.7.19 · 正式版 · 2026-11-21', '手动填写…'])
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/v1/app-releases', body: { version: '0.7.19', note: '' } }])
    expect(toast.message).toContain('已新建草稿 0.7.19')
    expect(router.currentRoute.value.path).toBe('/app-releases/0.7.19')
  })

  it('takes a typed version when the release list cannot be read', async () => {
    const { calls } = market([], (path) => (path === '/api/v1/app-releases/available' ? { status: 503, body: { error: 'GitHub 发布列表暂时读不到，请直接填写版本号' } } : undefined))
    const page = await start()
    expect(page.find('.empty-title').text()).toBe('还没有要发布的版本')
    await page.find('.page-header .btn-primary').trigger('click')
    await settle()
    const dialog = page.find('dialog[aria-labelledby="release-create-title"]')
    expect(dialog.find('#release-choice').exists()).toBe(false)
    await dialog.find('#release-version').setValue('0.8')
    await dialog.find('form').trigger('submit')
    expect(dialog.find('output[role="alert"]').text()).toBe('版本号须为稳定版格式 x.y.z')
    await dialog.find('#release-version').setValue('v0.8.1')
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([{ version: '0.8.1', note: '' }])
  })
})

describe('one version', () => {
  const rolling = () => release({ status: 'rolling', percent: 20, early: [101], hold: [102], earlyUsers: [{ id: 5001, name: '沈一', organization: { id: 102, name: '澄海设计' } }], offered: 5, upgraded: 1 })

  it('opens from the list on its own address and comes back with Esc', async () => {
    market([rolling()])
    const page = await start()
    await page.find('tr.release-row').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/app-releases/0.8.0')
    expect(page.find('.page-title').text()).toBe('0.8.0')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(router.currentRoute.value.path).toBe('/app-releases')
    expect(page.find('tr.release-row').exists()).toBe(true)
  })

  it('lays the scope out as 先发, 其余按比例 and 暂缓, with organizations and users', async () => {
    market([rolling()])
    const page = await start('#app-releases/0.8.0')
    expect(page.findAll('.scope-title').slice(0, 3).map((node) => node.text())).toEqual(['先发', '其余的人：按比例', '暂缓'])
    expect(page.find('.scope-early').findAll('.scope-item').map((item) => item.text().replace(/\s+/gu, ' '))).toEqual(['组织北辰研发 (#101)移除', '用户沈一 (#5001) · 澄海设计移除'])
    expect(page.find('.scope-hold').findAll('.scope-item').map((item) => item.text().replace(/\s+/gu, ' '))).toEqual(['组织澄海设计 (#102)移除'])
    expect((page.find('#release-percent').element as HTMLInputElement).value).toBe('20')
    expect(page.find('.scope-rest').text()).toContain('按最近 7 天的 40 台安装估算，约 8 台')
    expect(page.find('#release-state-title').text()).toBe('现在：发布中')
  })

  it('shows what GitHub says about the version, and says so when it cannot be read', async () => {
    market([rolling(), release({ version: '0.7.5', status: 'paused' })])
    const page = await start('#app-releases/0.8.0')
    const info = page.find('section[aria-labelledby="release-info-title"]')
    expect(info.text()).toContain('更新提醒不再每次弹窗。')
    expect(info.findAll('li').map((item) => item.text())).toEqual(['一', '二', '三', '四', '五', '六'])
    await byText(page, 'button', '展开全部 7 条').trigger('click')
    expect(info.findAll('li')).toHaveLength(7)
    expect(info.text()).toContain('TokensCowork-0.8.0-windows-amd64-installer.exe')
    expect(info.text()).toContain('258 MB')
    await router.push('/app-releases/0.7.5')
    await settle()
    expect(page.find('section[aria-labelledby="release-info-title"]').text()).toContain('读不到这个版本的信息。')
    expect(page.find('.scope-early').exists()).toBe(true)
  })

  it('adds an organization and a user to a list and saves a draft without asking', async () => {
    const { calls } = market([release({ early: [101] })])
    const page = await start('#app-releases/0.8.0')
    await page.find('.scope-hold button').trigger('click')
    const adder = page.find('dialog[aria-labelledby="release-adder-title"]')
    expect(adder.find('#release-adder-title').text()).toBe('添加到暂缓名单')
    const orgButtons = adder.findAll('.list-group-item-action')
    expect(orgButtons.map((node) => node.text().replace(/\s+/gu, ' '))).toEqual(['北辰研发 #101已在先发名单', '澄海设计 #102添加'])
    expect((orgButtons[0]!.element as HTMLButtonElement).disabled).toBe(true)
    await orgButtons[1]!.trigger('click')
    await adder.find('#adder-user').setValue('林')
    await byText(adder as never, 'button', '搜索').trigger('click')
    await settle()
    await adder.findAll('.list-group-item-action').find((node) => node.text().includes('林晚'))!.trigger('click')
    await adder.find('form').trigger('submit')
    await page.find('#release-percent').setValue('15')
    expect(page.find('.card-footer').text()).toContain('有未保存的修改')
    await byText(page, 'button', '保存范围').trigger('click')
    await settle()
    expect(confirmDialog(page).element).toHaveProperty('open', false)
    expect(patches(calls)).toEqual([{ method: 'PATCH', path: '/api/v1/app-releases/0.8.0',
      body: { percent: 15, note: '', early: [101], hold: [102], earlyUsers: [], holdUsers: [5002] } }])
  })

  it('asks before saving the scope of a version that is being offered', async () => {
    const { calls } = market([rolling()])
    const page = await start('#app-releases/0.8.0')
    await page.find('.scope-early button[aria-label="从先发移除 北辰研发 (#101)"]').trigger('click')
    await byText(page, 'button', '保存范围').trigger('click')
    await settle()
    expect(confirmDialog(page).find('#confirm-title').text()).toBe('保存 0.8.0 的范围？')
    expect(confirmDialog(page).findAll('li').map((item) => item.text())).toEqual(['先发：沈一 (#5001)', '其余的人：20%', '暂缓：澄海设计 (#102)'])
    await answer(page, '')
    expect(patches(calls)).toEqual([])
    await byText(page, 'button', '保存范围').trigger('click')
    await settle()
    await answer(page, 'ok')
    expect(patches(calls).map((call) => call.body)).toEqual([{ percent: 20, note: '', early: [], hold: [102], earlyUsers: [5001], holdUsers: [] }])
  })

  it('confirms every action that starts offering a version, listing who receives it', async () => {
    const { calls } = market([release({ percent: 5, early: [101] })])
    const page = await start('#app-releases/0.8.0')
    await byText(page, 'button', '开始发布').trigger('click')
    await settle()
    expect(confirmDialog(page).find('#confirm-title').text()).toBe('开始发布 0.8.0？')
    expect(confirmDialog(page).findAll('li').map((item) => item.text())).toEqual(['先发：北辰研发 (#101)', '其余的人：5%', '暂缓：无'])
    await answer(page, '')
    expect(patches(calls)).toEqual([])
    await byText(page, 'button', '开始发布').trigger('click')
    await settle()
    await answer(page, 'ok')
    expect(patches(calls)).toEqual([{ method: 'PATCH', path: '/api/v1/app-releases/0.8.0', body: { status: 'rolling' } }])
    expect(toast.message).toBe('0.8.0 已开始发布。')
  })

  it('offers the actions each status allows and refuses them while the scope is unsaved', async () => {
    const { calls } = market([rolling()])
    const page = await start('#app-releases/0.8.0')
    const actions = () => page.find('section[aria-labelledby="release-state-title"]').findAll('button').map((node) => node.text())
    expect(actions()).toEqual(['改为全量', '暂停'])
    await page.find('#release-percent').setValue('50')
    await byText(page, 'button', '改为全量').trigger('click')
    await settle()
    expect(toast.message).toBe('范围有未保存的修改，请先保存或撤销。')
    expect(patches(calls)).toEqual([])
    await byText(page, 'button', '撤销修改').trigger('click')
    await byText(page, 'button', '暂停').trigger('click')
    await settle()
    expect(confirmDialog(page).find('#confirm-title').text()).toBe('暂停 0.8.0？')
    await answer(page, 'ok')
    expect(patches(calls).map((call) => call.body)).toEqual([{ status: 'paused' }])
  })

  it('asks before leaving with unsaved changes', async () => {
    market([rolling()])
    const page = await start('#app-releases/0.8.0')
    await page.find('#release-note').setValue('改一下')
    await byText(page, 'button', '← 版本发布').trigger('click')
    await settle()
    expect(confirmDialog(page).find('#confirm-title').text()).toBe('放弃未保存的修改？')
    await answer(page, '')
    expect(router.currentRoute.value.path).toBe('/app-releases/0.8.0')
    await byText(page, 'button', '← 版本发布').trigger('click')
    await settle()
    await answer(page, 'ok')
    expect(router.currentRoute.value.path).toBe('/app-releases')
  })

  it('deletes a draft only after the confirmation and returns to the list', async () => {
    const { calls } = market([release({})])
    const page = await start('#app-releases/0.8.0')
    await byText(page, 'button', '删除草稿').trigger('click')
    await settle()
    expect(confirmDialog(page).find('#confirm-title').text()).toBe('删除草稿 0.8.0？')
    await answer(page, 'ok')
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/v1/app-releases/0.8.0', body: undefined }])
    expect(router.currentRoute.value.path).toBe('/app-releases')
  })

  it('says when the address names no rollout', async () => {
    market([])
    const page = await start('#app-releases/0.9.9')
    expect(page.find('.empty-title').text()).toBe('没有 0.9.9 这个发布')
  })
})

describe('the activity log wording for rollouts', () => {
  it('names the change, the version and its facts, users included once a version has any', async () => {
    const { ACTIONS, factsText, targetText } = await import('../activity')
    const event = { action: 'app-release.updated', target: '0.8.0', details: { status: 'rolling', percent: 10, earlyCount: 1, holdCount: 0 }, createdAt: 1 }
    const names = { organization: String, key: String, user: String, plugin: String } as never
    expect([ACTIONS[event.action], targetText(event, names), factsText(event)]).toEqual(['修改灰度版本', '版本 0.8.0', '发布中 · 比例 10% · 先发 1 个组织 · 暂缓 0 个组织'])
    expect(factsText({ ...event, details: { ...event.details, earlyUserCount: 2, holdUserCount: 1 } })).toBe('发布中 · 比例 10% · 先发 1 个组织 · 暂缓 0 个组织 · 先发 2 个用户 · 暂缓 1 个用户')
    expect([ACTIONS['app-release.created'], ACTIONS['app-release.deleted']]).toEqual(['新建灰度版本', '删除灰度草稿'])
  })
})
