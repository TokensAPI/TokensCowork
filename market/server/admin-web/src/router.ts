import { createRouter, type RouteLocationRaw, type RouterHistory } from 'vue-router'
import { legacyHashHistory } from './history'
import { allowedViews, onSessionChange, state } from './session'
import { VIEWS } from './views'
import KeysPage from './pages/KeysPage.vue'
import LegacyPage from './pages/LegacyPage.vue'
import SessionLogsPage from './pages/SessionLogsPage.vue'

/**
 * One route per page, at the old console's addresses (#keys). A page that has not moved here yet
 * is a short card pointing at /admin/#<page>; the sidebar links there directly.
 */
const migrated: Record<string, unknown> = { keys: KeysPage, 'session-logs': SessionLogsPage }
// A page's own route after its name: one session's detail is #session-logs/<session>/<format version>.
// One record, so the list and an opened session are the same page and the list keeps its state.
const paths: Record<string, string> = { 'session-logs': '/session-logs/:id?/:version?' }

/** Where an account lands: its first page drawn here, else its first page. */
export function homeFor(allowed: string[]): RouteLocationRaw {
  const first = VIEWS.find((view) => view.migrated && allowed.includes(view.id)) ?? VIEWS.find((view) => allowed.includes(view.id))
  return { name: first?.id ?? 'keys' }
}

export function createConsoleRouter(history: RouterHistory = legacyHashHistory()) {
  const router = createRouter({
    history,
    routes: [
      { path: '/', redirect: () => homeFor(allowedViews.value) },
      ...VIEWS.map((view) => ({
        path: paths[view.id] ?? `/${view.id}`,
        name: view.id,
        component: (migrated[view.id] ?? LegacyPage) as never,
        meta: { view: view.id },
      })),
      // A page's own route after a slash (#session-logs/<id>/4) belongs to the old console for now.
      // An address under a page that has none of its own goes to the page.
      {
        path: '/:view/:rest(.*)',
        component: LegacyPage,
        meta: { view: '' },
        beforeEnter: (to) => (migrated[String(to.params.view)] ? `/${String(to.params.view)}` : true),
      },
      { path: '/:unknown(.*)', redirect: '/' },
    ],
  })
  // A page this account may not open goes to its home page. Before sign-in nothing is drawn, so
  // the check waits for the session (onSessionChange re-runs it).
  router.beforeEach((to) => {
    if (!state.session) return true
    const view = String(to.meta.view || to.params.view || '')
    return allowedViews.value.includes(view) ? true : homeFor(allowedViews.value)
  })
  onSessionChange((signedIn) => {
    if (signedIn) void router.replace({ path: router.currentRoute.value.fullPath, force: true })
  })
  return router
}
