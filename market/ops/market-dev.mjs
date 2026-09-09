/**
 * Isolated localhost QA environment. All data is fictional and held in memory.
 * Never reads deployment credentials, contacts TokensAPI/npm, or writes database files.
 * Usage: npm --prefix market run dev   |   npm --prefix market run dev:check
 */
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import worker from '../_worker.js'
import { fingerprint } from '../server/security/key-fingerprint.js'
import { sealKey } from '../server/security/key-vault.js'

const root = resolve(import.meta.dirname, '..')
const HOST = '127.0.0.1'
const CREDENTIAL = 'market-test'
const runStatement = Symbol('run local prepared statement')
const nativeFetch = globalThis.fetch.bind(globalThis)
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }

async function fixtureEnvironment() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const migrationPath = resolve(root, 'database/migrations')
  for (const name of (await readdir(migrationPath)).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(await readFile(resolve(migrationPath, name), 'utf8'))
  }
  const wrap = (sql, values = []) => ({
    bind: (...next) => wrap(sql, next),
    first: async () => db.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => db.prepare(sql).run(...values),
    [runStatement]: () => db.prepare(sql).run(...values),
  })
  const organizations = [
    { id: 101, name: '北辰研发 · 测试' },
    { id: 102, name: '澄海设计 · 测试' },
    { id: 103, name: '已停用组织 · 测试' },
  ]
  const env = {
    MARKET_ADMIN_TOKEN: CREDENTIAL,
    MARKET_HMAC_SECRET: 'local-fixture-hmac-not-for-production',
    MARKET_KEY_ENCRYPTION_SECRET: 'local-fixture-encryption-not-for-production',
    MARKET_ACCESS_REQUIRED: 'true',
    // The provider below is injected. This origin only drives the development badge.
    MARKET_ORGANIZATIONS_BASE_URL: 'https://dev.tokensapi.ai',
    MARKET_ORGANIZATIONS: {
      resolveOrganization: async key => key === 'sk-test-org' ? organizations[0]
        : key === 'sk-test-other' ? organizations[1] : key === 'sk-test-disabled' ? organizations[2] : null,
      listOrganizations: async () => organizations.map(org => ({ ...org })),
    },
    MARKET_DB: {
      prepare: wrap,
      batch: async statements => {
        // Execute synchronously inside one transaction, so concurrent HTTP requests
        // cannot interleave transactions while awaited D1-compatible methods run.
        db.exec('BEGIN')
        try {
          const results = statements.map(statement => statement[runStatement]())
          db.exec('COMMIT')
          return results
        } catch (error) { db.exec('ROLLBACK'); throw error }
      },
    },
    MARKET_PACKAGES: { get: async key => key === 'fixtures/test-plugin.tgz' ? { body: 'LOCAL QA FIXTURE ONLY - NOT AN INSTALLABLE PACKAGE' } : null },
    ASSETS: {
      async fetch(input) {
        const url = new URL(input instanceof Request ? input.url : input)
        const pathname = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname
        let decoded
        try { decoded = decodeURIComponent(pathname) } catch { return new Response('Invalid path', { status: 400 }) }
        const path = resolve(root, '.' + decoded)
        if (!path.startsWith(root + sep)) return new Response('Not found', { status: 404 })
        try {
          const data = await readFile(path)
          return new Response(data, { headers: {
            'content-type': MIME[extname(path)] ?? 'application/octet-stream',
            'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          } })
        } catch { return new Response('Not found', { status: 404 }) }
      },
    },
  }
  const roster = JSON.parse(await readFile(resolve(root, 'roster.json'), 'utf8'))
  const restricted = roster.items.find(item => item.id === 'tokens-media-gen')
    ?? roster.items.find(item => item.category === 'optional')
  if (!restricted) throw new Error('A local optional roster item is required for QA')
  const fp = await fingerprint('sk-test-direct', env.MARKET_HMAC_SECRET)
  const encrypted = await sealKey('sk-test-direct', restricted.id, fp, env)
  await env.MARKET_DB.batch([
    ...organizations.map(org => wrap('INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,?)').bind(org.id, org.name, org.id === 103 ? 0 : 1)),
    wrap('INSERT INTO market_plugins(id,visibility,metadata,object_key) VALUES(?,?,?,?)')
      .bind(restricted.id, 'restricted', JSON.stringify(restricted), 'fixtures/test-plugin.tgz'),
    wrap('INSERT INTO market_org_policies(plugin_id) VALUES(?)').bind(restricted.id),
    wrap('INSERT INTO market_org_grants(plugin_id,organization_id) VALUES(?,?)').bind(restricted.id, 101),
    wrap('INSERT INTO market_plugin_key_grants(plugin_id,fingerprint) VALUES(?,?)').bind(restricted.id, fp),
    wrap('INSERT INTO market_plugin_key_values(plugin_id,fingerprint,encrypted_value) VALUES(?,?,?)').bind(restricted.id, fp, encrypted),
  ])
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : input)
    // Registry responses are deterministic fixtures; unknown destinations are blocked.
    if (url.origin === 'https://registry.npmjs.org') {
      const match = /^\/-\/package\/(.+)\/dist-tags$/u.exec(url.pathname)
      const item = roster.items.find(item => item.package === (match?.[1] ?? ''))
      return item ? Response.json({ latest: item.version }) : new Response('Fixture package not found', { status: 404 })
    }
    throw new Error('External network is disabled in local market QA')
  }
  return { env, db, restricted }
}

async function start(port) {
  const fixture = await fixtureEnvironment()
  const server = createServer(async (incoming, outgoing) => {
    try {
      const address = server.address()
      const origin = `http://${HOST}:${address.port}`
      // Reject DNS rebinding/foreign Host headers even though the listener is loopback-only.
      if (incoming.headers.host !== `${HOST}:${address.port}`) {
        outgoing.writeHead(403); outgoing.end('Use the printed loopback URL'); return
      }
      const chunks = []
      let size = 0
      for await (const chunk of incoming) {
        size += chunk.length
        if (size > 65536) { outgoing.writeHead(413); outgoing.end('Request too large'); return }
        chunks.push(chunk)
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      headers.set('cf-connecting-ip', HOST)
      const request = new Request(new URL(incoming.url, origin), {
        method: incoming.method, headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }),
      })
      const response = await worker.fetch(request, fixture.env, { waitUntil: promise => promise.catch(() => {}) })
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ error: 'Local QA request failed' }))
    }
  })
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, HOST, resolveReady) })
  const origin = `http://${HOST}:${server.address().port}`
  return {
    ...fixture, origin,
    close: async () => { await new Promise(resolveClosed => server.close(resolveClosed)); fixture.db.close() },
  }
}

async function smoke() {
  const app = await start(0)
  try {
    // nativeFetch is used only for this exact loopback origin, never for upstreams.
    const call = (path, data, cookie) => nativeFetch(app.origin + path, {
      method: data === undefined ? 'GET' : 'PUT',
      headers: { Origin: app.origin, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    assert.equal((await call('/admin/')).status, 200)
    assert.equal((await call('/admin/assets/market-admin.js')).status, 200)
    assert.equal((await call('/api/admin/operations')).status, 401)
    const login = await call('/api/admin/login', { credential: CREDENTIAL })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    assert.equal((await call('/api/admin/access', undefined, cookie)).status, 200)
    const preview = await (await call('/api/admin/access-preview', { apiKey: 'sk-test-org' }, cookie)).json()
    assert.equal(preview.organization.id, 101)
    assert.equal(preview.items.find(item => item.id === app.restricted.id).reason, 'organization')
    const direct = await (await call('/api/admin/access-preview', { apiKey: 'sk-test-direct' }, cookie)).json()
    assert.equal(direct.items.find(item => item.id === app.restricted.id).reason, 'direct')
    assert.equal((await call('/api/admin/plugin-access', {
      id: app.restricted.id, metadata: app.restricted, organizationIds: [], apiKeys: [], keepFingerprints: [], confirmPublic: true,
    }, cookie)).status, 200)
    const activities = await (await call('/api/admin/operations', undefined, cookie)).json()
    assert.equal(activities.recentActions[0].action, 'plugin.access.updated')
    assert.equal((await call('/v1/plugins')).status, 200)
    assert.equal((await call('/server/security/admin-session.js')).status, 404)
    await assert.rejects(globalThis.fetch('https://tokensapi.ai/api/organizations/all'), /External network/u)
    console.log('Local market QA smoke passed: login, session, organization/direct access, permission save, audit, catalog, and network isolation.')
  } finally { await app.close() }
}

if (process.argv.includes('--smoke')) {
  await smoke()
} else {
  const app = await start(8788)
  console.log(`Local market QA ready: ${app.origin}/admin/`)
  console.log('Fixture login: market-test | organization Key: sk-test-org | direct Key: sk-test-direct')
  console.log('All organizations, credentials and packages are TEST FIXTURES. External network is blocked; memory data resets on restart.')
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0)) })
}
