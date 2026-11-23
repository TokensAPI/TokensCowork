import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import type { Router } from 'vue-router'
import { hashFromRoute, legacyHashHistory, routeFromHash } from './history'
import { createConsoleRouter } from './router'
import { allowedViews, restore, state } from './session'
import AppSidebar from './components/AppSidebar.vue'
import { fakeMarket, settle } from './test-support'

const PLATFORM = { authenticated: true, role: 'platform', organizationId: null, organizationName: null, userId: null, environment: { name: 'production' } }
const ORGANIZATION = { authenticated: true, role: 'organization', organizationId: 101, organizationName: '测试组织', userId: '5001' }

let router: Router | undefined
function start(hash: string) {
  history.replaceState(null, '', `/admin/${hash}`)
  router = createConsoleRouter(legacyHashHistory())
  // What installing it in the app does: the first navigation, to the address the page opened at.
  void router.push(router.options.history.location)
  return router
}
async function signIn(session: object) {
  fakeMarket((path) => (path === '/api/v1/session' ? { body: session } : { body: { items: [], displayReady: true } }))
  await restore()
  await settle()
}

beforeEach(() => {
  state.session = null
  state.pending = true
})
afterEach(() => {
  router?.options.history.destroy()
  router = undefined
  vi.unstubAllGlobals()
})

describe('addresses', () => {
  it('are written as at /admin/: #keys, not #/keys', () => {
    expect([routeFromHash('#keys'), routeFromHash('#/keys'), routeFromHash(''), routeFromHash('#session-logs/abc/4')]).toEqual(['/keys', '/keys', '/', '/session-logs/abc/4'])
    history.replaceState(null, '', '/admin/')
    expect([hashFromRoute('/keys'), hashFromRoute('/')]).toEqual(['#keys', '/admin/'])
  })

  it('an old-console address opens the same page, and a push writes the old form', async () => {
    const router = start('#keys')
    await signIn(PLATFORM)
    await router.isReady()
    expect(router.currentRoute.value.name).toBe('keys')
    expect(router.resolve({ name: 'users' }).href).toBe('#users')
    await router.push({ name: 'plugins' })
    expect(location.hash).toBe('#plugins')
  })
})

describe('who sees which page', () => {
  it('the platform administrator sees every page and lands on the first one drawn here', async () => {
    const router = start('')
    await signIn(PLATFORM)
    expect(allowedViews.value).toEqual(['plugins', 'organizations', 'users', 'keys', 'docs', 'session-logs', 'activity'])
    await router.isReady()
    expect(router.currentRoute.value.name).toBe('plugins')
    expect(location.hash).toBe('#plugins')
  })

  it('an organization administrator sees only its own organization, even when asking for another page', async () => {
    const router = start('#keys')
    await signIn(ORGANIZATION)
    await router.isReady()
    await settle()
    expect(allowedViews.value).toEqual(['organizations'])
    expect(router.currentRoute.value.name).toBe('organizations')
    const sidebar = mount(AppSidebar, { global: { plugins: [router] } })
    await settle()
    // Its one page, named for it, with no count.
    expect(sidebar.findAll('#sidebar-menu .navbar-nav:first-child .nav-link').map((link) => [link.text(), link.attributes('href')])).toEqual([['我的组织', '#organizations']])
    sidebar.unmount()
  })

  it('the sidebar links every page at its old address, the directories with their counts', async () => {
    const router = start('#keys')
    await signIn(PLATFORM)
    await router.isReady()
    const sidebar = mount(AppSidebar, { global: { plugins: [router] } })
    await settle()
    const links = sidebar.findAll('#sidebar-menu .navbar-nav:first-child .nav-link').map((link) => [link.text(), link.attributes('href'), link.classes('active')])
    expect(links).toEqual([
      ['插件—', '#plugins', false],
      ['组织—', '#organizations', false],
      ['用户—', '#users', false],
      ['Key—', '#keys', true],
      ['插件文档', '#docs', false],
      ['会话日志', '#session-logs', false],
      ['操作记录', '#activity', false],
    ])
    sidebar.unmount()
  })
})
