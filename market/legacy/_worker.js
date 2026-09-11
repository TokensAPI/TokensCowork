/**
 * Thin edge proxy for the legacy entry tokenscowork-market.pages.dev.
 *
 * Every desktop build shipped before 0.4.12 has this origin baked in, so the
 * entry must stay alive forever. After the backend moved to the self-hosted
 * unit (market/server), this worker forwards everything there — one source of
 * truth, no split-brain — with a single exception: /source.json must keep the
 * pages.dev endpoint, because the desktop trust root requires the manifest and
 * its transport endpoint to share an origin. The copy served here is the last
 * manifest generated for this origin; never regenerate it against a new one.
 */
const ORIGIN = 'https://market.tokensapi.ai'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
      return Response.redirect(new URL(url.pathname + url.search, ORIGIN), 302)
    if (url.pathname === '/source.json') {
      if (!['GET', 'HEAD'].includes(request.method)) return Response.json({ error: 'method not allowed' }, { status: 405 })
      return env.ASSETS.fetch(new URL('/source.json', request.url).toString())
    }
    const headers = new Headers(request.headers)
    headers.delete('host')
    // The origin keys its login rate limit on the real client, not our egress.
    const client = request.headers.get('cf-connecting-ip')
    if (client) headers.set('x-edge-client-ip', client)
    try {
      const response = await fetch(new URL(url.pathname + url.search, ORIGIN), {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'manual',
      })
      // Older clients only forward credentials to their original trusted origin.
      // Keep package download URLs on that origin too; never redirect tarballs.
      if (url.pathname.startsWith('/registry/') && response.ok
        && response.headers.get('content-type')?.includes('application/json')) {
        const data = await response.json()
        for (const version of Object.values(data.versions ?? {})) {
          if (typeof version?.dist?.tarball !== 'string') continue
          const target = new URL(version.dist.tarball)
          if (target.origin === ORIGIN && target.pathname.startsWith('/registry/'))
            version.dist.tarball = url.origin + target.pathname + target.search
        }
        const out = new Headers(response.headers)
        out.delete('content-length')
        out.delete('content-encoding')
        out.delete('etag')
        return new Response(JSON.stringify(data), {status: response.status, headers: out})
      }
      return new Response(response.body, response)
    } catch {
      return Response.json({ error: '市场服务暂时不可用' }, { status: 502 })
    }
  },
}
