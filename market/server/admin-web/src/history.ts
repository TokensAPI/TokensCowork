import type { HistoryState, RouterHistory } from 'vue-router'

type NavigationCallback = Parameters<RouterHistory['listen']>[0]
type NavigationInformation = Parameters<NavigationCallback>[2]

/**
 * Hash addresses written the way the console at /admin/ writes them: `#keys`, `#session-logs/<id>/4`
 * -- no slash after the '#', which vue-router's own hash history always adds. A route '/keys' is
 * the address '#keys' and back; an old link or bookmark opens the same page in either console.
 *
 * Otherwise this is vue-router's HTML5 history (history.state carries the position, so back and
 * forward are told apart and a refused navigation can be undone with go(-delta, false)).
 */
type State = HistoryState & { position: number; back: string | null; current: string; forward: string | null }

/** '#keys' -> '/keys'; '' or '#' -> '/'. */
export function routeFromHash(hash: string) {
  return '/' + hash.replace(/^#\/?/u, '')
}
/** '/keys' -> '#keys'; '/' -> the page itself, with no fragment. */
export function hashFromRoute(route: string) {
  const path = route.replace(/^\/+/u, '')
  return path ? '#' + path : location.pathname + location.search
}

export function legacyHashHistory(): RouterHistory {
  let current = routeFromHash(location.hash)
  let state = history.state as State | null
  let paused: string | null = null
  const listeners: NavigationCallback[] = []

  function write(to: string, next: State, replace: boolean) {
    history[replace ? 'replaceState' : 'pushState'](next, '', hashFromRoute(to))
    state = next
  }
  if (!state || typeof state.position !== 'number')
    write(current, { back: null, current, forward: null, position: history.length - 1, replaced: true, scroll: null }, true)

  function onPop(event: PopStateEvent) {
    const to = routeFromHash(location.hash)
    const from = current
    const before = state
    let delta = 0
    current = to
    if (event.state && typeof (event.state as State).position === 'number') {
      state = event.state as State
      if (paused !== null && paused === from) {
        paused = null
        return
      }
      delta = before ? state.position - before.position : 0
    } else {
      // A hash typed into the address bar, or a plain <a href="#...">: a new entry with no state.
      write(to, { back: from, current: to, forward: null, position: (before?.position ?? history.length - 2) + 1, replaced: false, scroll: null }, true)
    }
    for (const listener of listeners)
      listener(current, from, { delta, type: 'pop' as NavigationInformation['type'], direction: (delta > 0 ? 'forward' : delta < 0 ? 'back' : '') as NavigationInformation['direction'] })
  }
  window.addEventListener('popstate', onPop)

  return {
    base: '',
    get location() {
      return current
    },
    get state() {
      return state ?? {}
    },
    push(to, data) {
      const position = state?.position ?? history.length - 1
      write(current, { ...(state as State), forward: to, scroll: { left: scrollX, top: scrollY } }, true)
      write(to, { back: current, current: to, forward: null, position: position + 1, replaced: false, scroll: null, ...data }, false)
      current = to
    },
    replace(to, data) {
      write(to, { back: state?.back ?? null, current: to, forward: state?.forward ?? null, position: state?.position ?? history.length - 1, replaced: true, scroll: null, ...data }, true)
      current = to
    },
    go(delta, triggerListeners = true) {
      if (!triggerListeners) paused = current
      history.go(delta)
    },
    listen(callback) {
      listeners.push(callback)
      return () => {
        const at = listeners.indexOf(callback)
        if (at > -1) listeners.splice(at, 1)
      }
    },
    createHref: (route) => (route.replace(/^\/+/u, '') ? '#' + route.replace(/^\/+/u, '') : '#'),
    destroy() {
      listeners.length = 0
      window.removeEventListener('popstate', onPop)
    },
  }
}
