import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import AppReleasesPage from './AppReleasesPage.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ToastMessage from '../components/ToastMessage.vue'
import { notify, toast } from '../feedback'
import { fakeMarket, settle, type Reply } from '../test-support'
import type { AppRelease } from '../appReleases'

const ORGS = [
  { id: 101, name: '北辰研发', enabled: true },
  { id: 102, name: '澄海设计', enabled: true },
]
const release = (fields: Partial<AppRelease>): AppRelease => ({
  version: '0.8.0', status: 'draft', percent: 0, note: '', early: [], hold: [], offered: 0, upgraded: 0, createdAt: 1, updatedAt: 1, ...fields,
})
const INSTALLS = { days: 7, total: 4, versions: [{ version: '0.8.0', count: 1 }, { version: '0.7.19', count: 3 }] }

function market(items: AppRelease[], override: (path: string, init: RequestInit) => Reply | undefined = () => undefined) {
  return fakeMarket((path, init) => {
    const answer = override(path, init)
    if (answer) return answer
    if (path === '/api/v1/app-releases' && (init.method ?? 'GET') === 'GET') return { body: { items, installations: INSTALLS } }
    if (path === '/api/v1/organizations') return { body: { items: ORGS, syncReady: true } }
    if (path === '/api/v1/app-releases/available') return { body: { items: [
      { version: '0.8.0', prerelease: true, publishedAt: '2026-11-25T00:00:00Z' },
      { version: '0.7.19', prerelease: false, publishedAt: '2026-11-21T00:00:00Z' },
    ] } }
    return { body: { ok: true } }
  })
}

let wrapper: VueWrapper | undefined
function mountPage() {
  wrapper = mount({ render: () => [h(AppReleasesPage), h(ConfirmDialog), h(ToastMessage)] }, { attachTo: document.body })
  return wrapper
}
const rows = (page: VueWrapper) => page.findAll('tbody tr').map((row) => row.findAll('td').slice(0, 6).map((cell) => cell.text()))
const button = (page: VueWrapper, label: string) => page.find(`button[aria-label="${label}"]`)

beforeEach(() => notify())
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
})

describe('the 版本发布 page', () => {
  it('lists each version with its status, reach, lists and counts, and the installs per version', async () => {
    market([
      release({ version: '0.9.0', note: '下一版' }),
      release({ status: 'rolling', percent: 10, early: [101], hold: [102], offered: 5, upgraded: 1 }),
    ])
    const page = mountPage()
    await settle()
    expect(rows(page)).toEqual([
      ['0.9.0下一版', '草稿', '不提供', '—', '—', '0 / 0'],
      ['0.8.0', '发布中', '10%', '北辰研发 (#101)', '澄海设计 (#102)', '5 / 1'],
    ])
    expect(page.findAll('.install-row').map((row) => row.text())).toEqual(['0.8.01 台 · 25%', '0.7.193 台 · 75%'])
    expect(page.find('.card-subtitle').text()).toBe('最近 7 天检查过更新的 4 台安装，按当前版本')
  })

  it('creates a draft from the GitHub release list, skipping versions already added', async () => {
    const { calls } = market([release({ version: '0.8.0' })])
    const page = mountPage()
    await settle()
    await page.find('.page-header .btn-primary').trigger('click')
    await settle()
    const dialog = page.find('dialog[aria-labelledby="release-create-title"]')
    expect(dialog.findAll('#release-choice option').map((o) => o.text())).toEqual(['0.7.19 · 正式版 · 2026-11-21', '手动填写…'])
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/v1/app-releases', body: { version: '0.7.19', note: '' } }])
    expect(toast.message).toContain('已新建草稿 0.7.19')
  })

  it('takes a typed version when the release list cannot be read', async () => {
    const { calls } = market([], (path) => (path === '/api/v1/app-releases/available' ? { status: 503, body: { error: 'GitHub 发布列表暂时读不到，请直接填写版本号' } } : undefined))
    const page = mountPage()
    await settle()
    await page.find('.page-header .btn-primary').trigger('click')
    await settle()
    const dialog = page.find('dialog[aria-labelledby="release-create-title"]')
    expect(dialog.find('#release-choice').exists()).toBe(false)
    expect(dialog.find('.form-hint').text()).toBe('GitHub 发布列表暂时读不到，请直接填写版本号。')
    await dialog.find('#release-version').setValue('0.8')
    await dialog.find('form').trigger('submit')
    expect(dialog.find('output[role="alert"]').text()).toBe('版本号须为稳定版格式 x.y.z')
    await dialog.find('#release-version').setValue('0.8.1')
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'POST').map((call) => call.body)).toEqual([{ version: '0.8.1', note: '' }])
  })

  it('edits status, percentage, organizations and note in one save', async () => {
    const { calls } = market([release({ early: [101] })])
    const page = mountPage()
    await settle()
    await button(page, '0.8.0 编辑').trigger('click')
    const dialog = page.find('dialog[aria-labelledby="release-dialog-title"]')
    expect((dialog.element as HTMLDialogElement).open).toBe(true)
    expect(dialog.find('.placement-summary').text()).toBe('先发 1 个组织 · 暂缓 0 个组织')
    await dialog.find('#release-status').setValue('rolling')
    await dialog.find('#release-percent').setValue('20')
    await dialog.find('select[aria-label="澄海设计 的发布方式"]').setValue('hold')
    await dialog.find('#release-note').setValue(' 内部先行 ')
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([{ method: 'PATCH', path: '/api/v1/app-releases/0.8.0',
      body: { status: 'rolling', percent: 20, note: '内部先行', early: [101], hold: [102] } }])
    expect(toast.message).toBe('0.8.0 已保存。')
  })

  it('offers draft only while it is one, and sends no percentage for full', async () => {
    const { calls } = market([release({ status: 'rolling', percent: 30 })])
    const page = mountPage()
    await settle()
    await button(page, '0.8.0 编辑').trigger('click')
    const dialog = page.find('dialog[aria-labelledby="release-dialog-title"]')
    expect(dialog.findAll('#release-status option').map((o) => o.attributes('value'))).toEqual(['rolling', 'paused', 'full'])
    await dialog.find('#release-status').setValue('full')
    expect((dialog.find('#release-percent').element as HTMLInputElement).disabled).toBe(true)
    await dialog.find('form').trigger('submit')
    await settle()
    expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([{ status: 'full', note: '', early: [], hold: [] }])
  })

  it('pauses at once; starting a draft asks first and says who receives it', async () => {
    const { calls } = market([release({ version: '0.9.0', early: [101], percent: 5 }), release({ status: 'rolling', percent: 10 })])
    const page = mountPage()
    await settle()
    await button(page, '0.8.0 暂停').trigger('click')
    await settle()
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([{ method: 'PATCH', path: '/api/v1/app-releases/0.8.0', body: { status: 'paused' } }])
    expect(toast.message).toBe('0.8.0 已暂停。')

    await button(page, '0.9.0 开始发布').trigger('click')
    await settle()
    const confirm = page.find('dialog[aria-labelledby="confirm-title"]')
    expect(confirm.find('#confirm-text').text()).toBe('先发组织（1 个）马上能收到；其他人按比例（当前 5%）；用户手动检查更新时不看比例，也能收到。暂缓组织始终收不到。可以随时暂停。')
    ;(confirm.element as HTMLDialogElement).close('ok')
    await settle()
    expect(calls.filter((call) => call.method === 'PATCH').at(-1)).toEqual({ method: 'PATCH', path: '/api/v1/app-releases/0.9.0', body: { status: 'rolling' } })
  })

  it('deletes a draft only after the confirmation', async () => {
    const { calls } = market([release({})])
    const page = mountPage()
    await settle()
    await button(page, '0.8.0 删除').trigger('click')
    await settle()
    const confirm = page.find('dialog[aria-labelledby="confirm-title"]')
    expect(confirm.find('#confirm-title').text()).toBe('删除草稿 0.8.0？')
    ;(confirm.element as HTMLDialogElement).close('ok')
    await settle()
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/v1/app-releases/0.8.0', body: undefined }])
  })

  it('says when there is nothing yet', async () => {
    market([])
    const page = mountPage()
    await settle()
    expect(page.find('.empty-title').text()).toBe('还没有灰度中的版本')
  })
})

describe('the activity log wording for rollouts', () => {
  it('names the change, the version and its facts', async () => {
    const { ACTIONS, factsText, targetText } = await import('../activity')
    const event = { action: 'app-release.updated', target: '0.8.0', details: { status: 'rolling', percent: 10, earlyCount: 1, holdCount: 0 }, createdAt: 1 }
    const names = { organization: String, key: String, user: String, plugin: String } as never
    expect([ACTIONS[event.action], targetText(event, names), factsText(event)]).toEqual(['修改灰度版本', '版本 0.8.0', '发布中 · 比例 10% · 先发 1 个组织 · 暂缓 0 个组织'])
    expect([ACTIONS['app-release.created'], ACTIONS['app-release.deleted']]).toEqual(['新建灰度版本', '删除灰度草稿'])
  })
})
