import { createRouter, type RouteLocationRaw, type RouterHistory } from 'vue-router'
import { legacyHashHistory } from './history'
import { allowedViews, onSessionChange, state } from './session'
import { VIEWS } from './views'
import PluginsPage from './pages/PluginsPage.vue'
import OrganizationsPage from './pages/OrganizationsPage.vue'
import UsersPage from './pages/UsersPage.vue'
import KeysPage from './pages/KeysPage.vue'
import DocsPage from './pages/DocsPage.vue'
import SessionLogsPage from './pages/SessionLogsPage.vue'
import ActivityPage from './pages/ActivityPage.vue'

/**
 * One route per page, at the addresses the console has always had (#plugins, #keys, …), so old
 * links and bookmarks keep working.
 */
const pages: Record<string, unknown> = {
  plugins: PluginsPage, organizations: OrganizationsPage, users: UsersPage, keys: KeysPage, docs: DocsPage, 'session-logs': SessionLogsPage, activity: ActivityPage,
}
// A page's own route after its name: one session's detail is #session-logs/<session>/<format version>.
// One record, so the list and an opened session are the same page and the list keeps its state.
const paths: Record<string, string> = { 'session-logs': '/session-logs/:id?/:version?' }

/** Where an account lands: its first page (the plugins for the platform, its organization otherwise). */
export function homeFor(allowed: string[]): RouteLocationRaw {
  return { name: VIEWS.find((view) => allowed.includes(view.id))?.id ?? 'plugins' }
}

export function createConsoleRouter(history: RouterHistory = legacyHashHistory()) {
  const router = createRouter({
    history,
    routes: [
      // Before anyone is signed in the address stays '/'; once signed in it is the account's home.
      { path: '/', component: { render: () => null }, meta: { view: '' } },
      ...VIEWS.map((view) => ({ path: paths[view.id] ?? `/${view.id}`, name: view.id, component: pages[view.id] as never, meta: { view: view.id } })),
      // An address under a page that has none of its own goes to the page; anything else home.
      { path: '/:view/:rest(.*)', redirect: (to) => (pages[String(to.params.view)] ? `/${String(to.params.view)}` : '/') },
      { path: '/:unknown(.*)', redirect: '/' },
    ],
  })
  // A page this account may not open goes to its home page. Before sign-in nothing is drawn, so
  // the check waits for the session (onSessionChange re-runs it).
  router.beforeEach((to) => {
    if (!state.session) return true
    if (to.path === '/') return homeFor(allowedViews.value)
    return allowedViews.value.includes(String(to.meta.view || '')) ? true : homeFor(allowedViews.value)
  })
  // After the first navigation (the address the page opened at), so that is the one re-checked.
  onSessionChange(async (signedIn) => {
    if (!signedIn) return
    await router.isReady()
    await router.replace({ path: router.currentRoute.value.fullPath, force: true })
  })
  return router
}
