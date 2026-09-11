/**
 * Self-hosted entry: serves the unchanged Cloudflare worker over node:http
 * behind an ops-owned reverse proxy (TLS terminates at Nginx). The public
 * origin is fixed by configuration, never derived from request headers, so
 * generated absolute URLs (tarball proxy links, CSRF origin checks) cannot be
 * steered by a spoofed Host header.
 */
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import worker from '../server/_worker.js'
import { createAssets, createD1Database, createPackagesStore } from './adapters.mjs'

const serverRoot = resolve(import.meta.dirname, '../server')
const dataDir = process.env.MARKET_HOST_DATA_DIR || '/data'
const port = Number(process.env.MARKET_HOST_PORT || 8080)
const publicOrigin = new URL(process.env.MARKET_HOST_PUBLIC_ORIGIN ?? (() => {
  throw new Error('MARKET_HOST_PUBLIC_ORIGIN is required, e.g. https://market.tokensapi.ai')
})())
if (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password
  || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) {
  throw new Error('MARKET_HOST_PUBLIC_ORIGIN must be a bare credential-free HTTPS origin')
}

mkdirSync(resolve(dataDir, 'packages'), { recursive: true })
const env = {
  // Every MARKET_* variable passes through verbatim; the bindings are replaced.
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('MARKET_'))),
  MARKET_DB: createD1Database(resolve(dataDir, 'market.sqlite'), resolve(serverRoot, 'database/migrations')),
  MARKET_PACKAGES: createPackagesStore(resolve(dataDir, 'packages')),
  ASSETS: createAssets(serverRoot),
}

const server = createServer(async (incoming, outgoing) => {
  try {
    // Reject foreign Host headers (DNS rebinding); loopback probes stay usable.
    const host = incoming.headers.host ?? ''
    if (host !== publicOrigin.host && !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(host)) {
      outgoing.writeHead(403, { 'content-type': 'text/plain' })
      outgoing.end('Unexpected Host header')
      return
    }
    const chunks = []
    let size = 0
    for await (const chunk of incoming) {
      size += chunk.length
      if (size > 1024 * 1024) { outgoing.writeHead(413); outgoing.end('Request too large'); return }
      chunks.push(chunk)
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
    }
    // The worker keys its login rate limit on cf-connecting-ip; only this
    // process may assert it. The edge proxy forwards the original client as
    // X-Edge-Client-IP, Nginx sets X-Real-IP for direct traffic.
    headers.delete('cf-connecting-ip')
    const client = incoming.headers['x-edge-client-ip'] || incoming.headers['x-real-ip'] || incoming.socket.remoteAddress || ''
    if (client) headers.set('cf-connecting-ip', Array.isArray(client) ? client[0] : client)
    const request = new Request(new URL(incoming.url, publicOrigin), {
      method: incoming.method,
      headers,
      ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }),
    })
    const response = await worker.fetch(request, env)
    const outHeaders = {}
    for (const [name, value] of response.headers) {
      if (name !== 'set-cookie') outHeaders[name] = value
    }
    const cookies = response.headers.getSetCookie()
    if (cookies.length) outHeaders['set-cookie'] = cookies
    outgoing.writeHead(response.status, outHeaders)
    if (response.body) {
      for await (const chunk of response.body) outgoing.write(chunk)
    }
    outgoing.end()
  } catch (error) {
    console.error(error)
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain' })
    outgoing.end('Internal error')
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`tokenscowork-market-host listening on ${port} for ${publicOrigin.origin}`)
})
