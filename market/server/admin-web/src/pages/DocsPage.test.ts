import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import DocsPage from './DocsPage.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { notify, toast } from '../feedback'
import { state } from '../session'
import { fakeMarket, settle } from '../test-support'

const PLUGINS = [
  { id: 'core', displayName: '内置', package: '@example/core', state: 'builtin', visibility: 'public', category: 'builtin' },
  { id: 'media-gen', displayName: '媒体生成', package: '@example/media-gen', state: 'published', visibility: 'restricted', category: 'optional' },
]
let wrapper: VueWrapper | undefined
function market(docs: object[] = []) {
  return fakeMarket((path, init) => {
    if (path === '/api/v1/plugins?view=index') return { body: { items: PLUGINS } }
    if (path === '/api/v1/plugins/media-gen/docs' && (init.method ?? 'GET') === 'GET') return { body: { items: docs } }
    if (path.startsWith('/api/v1/plugins/media-gen/docs/images?')) return { body: { url: '/v1/docs/media-gen/images/abc123' } }
    return { body: { ok: true } }
  })
}
async function mountPage() {
  wrapper = mount({ render: () => [h(DocsPage), h(ConfirmDialog)] }, { attachTo: document.body })
  await settle()
  return wrapper
}
async function choose(page: VueWrapper, files: File[]) {
  const input = page.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
  await settle()
}

beforeEach(() => {
  notify()
  state.session = { authenticated: true, role: 'platform', organizationId: null, organizationName: null, userId: null }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  state.session = null
  vi.unstubAllGlobals()
})

describe('the plugin documentation page', () => {
  it('offers the market plugins and lists the chosen one\'s pages', async () => {
    market([{ id: 1, title: '快速开始', body: '# 快速开始', position: 0, updatedAt: 1 }])
    const page = await mountPage()
    expect(page.findAll('select option').map((option) => option.text())).toEqual(['媒体生成（media-gen）'])
    expect(page.findAll('tbody tr td').slice(0, 3).map((cell) => cell.text())).toEqual(['快速开始', '0', '6 字'])
  })

  it('uploads a page with its image, pointing the relative path at the uploaded address', async () => {
    const { calls } = market()
    const page = await mountPage()
    await choose(page, [new File(['# 安装\n\n![第一步](images/Step-1.png)\n'], 'guide.md'), new File([new Uint8Array([1, 2, 3])], 'step-1.png')])
    const saved = calls.find((call) => call.method === 'POST' && call.path === '/api/v1/plugins/media-gen/docs')
    expect(saved?.body).toEqual({ title: '安装', body: '# 安装\n\n![第一步](/v1/docs/media-gen/images/abc123)\n', position: 0 })
    expect(toast.message).toBe('文档已上传，含 1 张图片。')
  })

  it('names the images a page uses but were not picked, and uploads only when told to', async () => {
    const { calls } = market()
    const page = await mountPage()
    await choose(page, [new File(['# 页\n![图](a.png)'], 'page.md')])
    const confirm = page.find('dialog[aria-labelledby="confirm-title"]')
    expect(confirm.find('#confirm-title').text()).toBe('正文引用的 1 张图片没有选')
    ;(confirm.element as HTMLDialogElement).close('cancel')
    await settle()
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('refuses two pages at once', async () => {
    market()
    const page = await mountPage()
    await choose(page, [new File(['# a'], 'a.md'), new File(['# b'], 'b.md')])
    expect(toast).toMatchObject({ kind: 'error', message: '一次只能上传一篇文档，图片可以多张。' })
  })
})
