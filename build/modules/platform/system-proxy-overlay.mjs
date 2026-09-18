// Only web-fetch falls back to Electron's OS proxy policy; never changes global env.
export function bridgeDesktopSystemProxy(source, role) {
  const marker = '// TokensCowork system proxy bridge'
  if (source.includes(marker)) return source
  const key = 'tokenscowork.resolveSystemProxy'
  if (role === 'main') {
    const anchor = "    const environment = loadLayeredEnv(BIN_NAME, process.cwd())"
    if (!source.includes(anchor)) throw new Error('system-proxy: main bootstrap changed')
    return source.replace(anchor, `${anchor}\n    ${marker}\n    ;(globalThis as unknown as Record<string, unknown>)[${JSON.stringify(key)}] = async (url: string) => {\n      const { session } = await import('electron')\n      return session.defaultSession.resolveProxy(url)\n    }`)
  }
  if (role === 'supervisor') {
    const anchor = "  rpc.handle('certificate', () => options.prepareCertificate())"
    if (!source.includes(anchor)) throw new Error('system-proxy: supervisor changed')
    return source.replace(anchor, `${anchor}\n  ${marker}\n  rpc.handle('product:resolve-proxy', async ([value]) => {\n    if (typeof value !== 'string') throw new Error('Invalid proxy target')\n    const url = new URL(value)\n    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid proxy target')\n    const { session } = await import('electron')\n    return session.defaultSession.resolveProxy(url.href)\n  })`)
  }
  const anchor = "let host: DesktopStartupGenerationHost | undefined"
  if (role !== 'host' || !source.includes(anchor)) throw new Error('system-proxy: host bootstrap changed')
  return source.replace(anchor, `${marker}\n;(globalThis as unknown as Record<string, unknown>)[${JSON.stringify(key)}] = (url: string, signal: AbortSignal) => rpc.call('product:resolve-proxy', [url], signal)\n${anchor}`)
}

// Self-contained for embedding into the installed runtime, and directly testable.
export async function resolveSystemProxyRoute(url, route, signal, resolveProxy, env, makeAgent) {
  if (route.proxied || !resolveProxy) return route
  // Do not override explicit routing or NO_PROXY (DSH may add loopback entries).
  if (['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(k => env[k] !== undefined)) return route
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (host === 'localhost' || host.endsWith('.localhost')) return route
  for (let item of (env.no_proxy ?? env.NO_PROXY ?? '').toLowerCase().split(/[,\s]+/)) {
    if (!item) continue
    if (item === '*') return route
    const parts = item.match(/^([^:]+):(\d+)$/)
    if (parts) { if (parts[2] !== port) continue; item = parts[1] }
    item = item.replace(/^\*?\./, '')
    if (host === item || host.endsWith(`.${item}`)) return route
  }
  signal.throwIfAborted()
  let abort
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  let answer
  try { answer = await Promise.race([resolveProxy(url.href, signal), cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
  signal.throwIfAborted()
  // Honor the first OS-selected route. Never silently bypass an unsupported proxy.
  const first = String(answer).split(';')[0].trim()
  if (first === 'DIRECT') return route
  const match = /^(PROXY|HTTPS)\s+([^\s/]+)$/.exec(first)
  if (!match) throw new Error('System web proxy is unavailable or unsupported (HTTP/HTTPS required)')
  const proxy = new URL(`${match[1] === 'HTTPS' ? 'https' : 'http'}://${match[2]}`)
  if (proxy.username || proxy.password || proxy.pathname !== '/') throw new Error('Invalid system web proxy')
  return { proxied: true, dispatcher: makeAgent(proxy.href), owned: true }
}

export function bridgeWebFetchSystemProxy(source) {
  const marker = '// TokensCowork web-fetch system proxy'
  if (source.includes(marker)) return source
  const anchor = 'const route = proxyRouteFor(url);'
  const request = 'if (route.proxied && !isNonPublicIpLiteral(url.hostname)) return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);'
  if (source.split(anchor).length !== 2 || !source.includes(request)) throw new Error('system-proxy: web-fetch runtime changed')
  return `${marker}\n${resolveSystemProxyRoute.toString()}\n` + source.replace(anchor, `const route = isNonPublicIpLiteral(url.hostname) ? proxyRouteFor(url) : await resolveSystemProxyRoute(url, proxyRouteFor(url), signal, globalThis['tokenscowork.resolveSystemProxy'], process.env, uri => new ProductProxyAgent(uri));`)
    .replace(request, `if (route.proxied && !isNonPublicIpLiteral(url.hostname)) {\n      try {\n        const result = await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);\n        if (!route.owned) return result;\n        return { response: result.response, close: async () => { try { await result.close(); } finally { await route.dispatcher.close(); } } };\n      } catch (error) { if (route.owned) await route.dispatcher.close(); throw error; }\n    }`)
    + '\nimport { ProxyAgent as ProductProxyAgent } from "undici";\n'
}
