/**
 * Isolated localhost QA environment. Held in memory, and local-only: nothing here ever writes
 * to production. The inventory is the production directory snapshot when one has been pulled
 * (npm --prefix market/server run pull), and fictional fixtures otherwise.
 * Never reads deployment credentials or contacts npm.
 * The Cloudflare bindings come from runtime/adapters.mjs — the same three adapters the
 * deployed server runs on, so there is one implementation to maintain rather than a parallel
 * one that drifts. Set MARKET_DEV_DATA_DIR to run against a real data directory (a copy of
 * the production volume's market.sqlite) instead of a throwaway database.
 * Usage: npm --prefix market/server run dev   |   npm --prefix market/server run dev:check
 */
import { createServer } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import worker from '../_worker.js'
import { fingerprint } from '../security/key-fingerprint.js'
import { sealKey } from '../security/key-vault.js'
import { createTokensApiOrganizations } from '../integrations/tokensapi-organizations.js'
import { createAssets, createD1Database } from '../runtime/adapters.mjs'
import { migrate } from '../database/migrate.mjs'

const root = resolve(import.meta.dirname, '..')
const HOST = '127.0.0.1'
try { process.loadEnvFile(resolve(root, '../.market-dev.env')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
const CREDENTIAL = process.env.MARKET_DEV_ADMIN_TOKEN || 'market-test'
const DOCS_CREDENTIAL_PATH = '/__dev/docs-credential'
const nativeFetch = globalThis.fetch.bind(globalThis)
// Console sign-in asks the real TokensAPI, because that is the part worth testing by hand.
// The smoke run keeps the fixture site instead, so it stays offline and deterministic.
const SITE = process.env.MARKET_DEV_TOKENSAPI || 'https://tokensapi.ai'
const LIVE_SITE = !process.argv.includes('--smoke')
// Once a production directory snapshot has been pulled (npm --prefix market/server run pull),
// local QA runs against it by default: one inventory to reason about instead of fixtures that
// quietly disagree with production. MARKET_DEV_SNAPSHOT points elsewhere; --smoke ignores both,
// so the automated run stays offline and deterministic. Delete the file to go back to fixtures.
const SNAPSHOT = !LIVE_SITE ? ''
  : process.env.MARKET_DEV_SNAPSHOT ? resolve(process.env.MARKET_DEV_SNAPSHOT)
  : existsSync(resolve(root, '../.market-production-snapshot.json')) ? resolve(root, '../.market-production-snapshot.json')
  : ''

async function fixtureEnvironment() {
  // A throwaway database unless MARKET_DEV_DATA_DIR names a real one, and either way the
  // adapter is the deployed one: migrations replayed on boot, same D1-compatible facade.
  const migrations = resolve(root, 'database/migrations')
  const persistent = Boolean(process.env.MARKET_DEV_DATA_DIR)
  const snapshotPath = persistent ? '' : SNAPSHOT
  // A production snapshot is shaped like production's schema, so it is loaded where production
  // stands (migration 006) and carried forward by the same migrations a deploy would run.
  let migrationsDir = migrations
  if (snapshotPath) {
    migrationsDir = await mkdtemp(resolve(tmpdir(), 'market-dev-migrations-'))
    for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql') && file < '007'))
      await copyFile(resolve(migrations, file), resolve(migrationsDir, file))
  }
  const store = createD1Database(persistent ? resolve(process.env.MARKET_DEV_DATA_DIR, 'market.sqlite') : ':memory:', migrationsDir)
  const db = store.database
  const wrap = store.prepare
  const organizations = [
    { id: 101, name: '北辰研发 · 测试' },
    { id: 102, name: '澄海设计 · 测试' },
    { id: 103, name: '已停用组织 · 测试' },
  ]
  // One credential per outcome the login has to tell apart: an organization administrator, a
  // plain member, an account in no organization, and an administrator of an organization
  // disabled here. Keyed by access token; the account id must match, as TokensAPI insists.
  const siteCredentials = {
    'dev-owner': { account: { id: 5001, username: 'owner', displayName: '组织所有者 · 测试' },
      organization: { ...organizations[0], role: 100 } },
    'dev-member': { account: { id: 5002, username: 'member', displayName: '普通成员 · 测试' },
      organization: { ...organizations[0], role: 1 } },
    'dev-outsider': { account: { id: 5003, username: 'outsider', displayName: '无组织账号 · 测试' },
      organization: null },
    'dev-disabled': { account: { id: 5004, username: 'disabled', displayName: '停用组织管理员 · 测试' },
      organization: { ...organizations[2], role: 100 } },
  }
  // Key owners for user grants. TokensAPI does not report them yet; these stand in until it does.
  const users = [
    { id: 6001, name: '测试用户甲', username: 'user-a' },
    { id: 6002, name: '测试用户乙', username: 'user-b' },
  ]
  const keyOwners = { 'sk-test-personal': users[0], 'sk-test-org': users[1] }
  const owner = key => keyOwners[key] ? { id: keyOwners[key].id, name: keyOwners[key].name } : null
  // The pair is checked as a pair, the way TokensAPI does it: a real token under someone else’s
  // account id is nobody.
  const fixtureAccount = credential => {
    const entry = siteCredentials[credential?.accessToken]
    return entry && entry.account.id === credential.userId ? entry : null
  }
  const env = {
    MARKET_ADMIN_TOKEN: CREDENTIAL,
    MARKET_HMAC_SECRET: 'local-fixture-hmac-not-for-production',
    MARKET_KEY_ENCRYPTION_SECRET: 'local-fixture-encryption-not-for-production',
    MARKET_ACCESS_REQUIRED: 'true',
    // The provider below is injected. This origin only drives the development badge.
    MARKET_ORGANIZATIONS_BASE_URL: 'https://dev.tokensapi.ai',
    MARKET_ORGANIZATIONS: {
      // Fictional console credentials standing in for tokensapi.ai. These two lookups are
      // everything the market asks upstream about a person signing in to the console.
      resolveAccount: async credential => fixtureAccount(credential)?.account ?? null,
      resolveMyOrg: async credential => fixtureAccount(credential)?.organization ?? null,
      resolveOrganization: async key => key === 'sk-test-org' ? organizations[0]
        : key === 'sk-test-other' ? organizations[1] : key === 'sk-test-disabled' ? organizations[2] : null,
      resolveIdentity: async key => ({ organization: key === 'sk-test-org' ? organizations[0]
        : key === 'sk-test-other' ? organizations[1] : key === 'sk-test-disabled' ? organizations[2] : null, user: owner(key) }),
      searchUsers: async keyword => {
        const items = users.filter(user => user.name.includes(keyword) || user.username.includes(keyword) || String(user.id) === keyword)
        return { items: items.map(user => ({ ...user })), total: items.length }
      },
      listOrganizations: async () => organizations.map(org => ({ ...org })),
    },
    MARKET_DB: store,
    ASSETS: createAssets(root),
  }
  const roster = { items: db.prepare('SELECT metadata FROM market_plugins').all().map(row => JSON.parse(row.metadata)) }
  let restricted = null
  if (snapshotPath) {
    // Production metadata only; never copies credentials and never writes to production.
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
    db.exec('BEGIN')
    try {
      for (const table of ['market_plugin_key_grants','market_org_grants','market_org_policies','market_keys','market_catalog','market_plugins','market_organizations']) db.exec(`DELETE FROM ${table}`)
      for (const p of snapshot.access.plugins) db.prepare('INSERT INTO market_plugins(id,visibility,metadata,object_key) VALUES(?,?,?,?)').run(p.id,p.visibility,JSON.stringify(p.metadata),null)
      for (const p of snapshot.catalog.items) db.prepare('INSERT INTO market_catalog(id,state,revision,version_mode,license_reference,reviewed_version) VALUES(?,?,?,?,?,?)').run(p.id,p.state,p.revision,p.versionMode || 'latest',p.licenseReference || '',p.reviewedVersion || '')
      for (const o of snapshot.access.organizations) db.prepare('INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,?)').run(o.id,o.name,o.enabled)
      for (const k of snapshot.access.keys) db.prepare('INSERT INTO market_keys(fingerprint,label,enabled,expires_at) VALUES(?,?,?,?)').run(k.fingerprint,k.label,k.enabled,k.expires_at)
      for (const p of snapshot.access.organizationPolicies) db.prepare('INSERT INTO market_org_policies(plugin_id) VALUES(?)').run(p.plugin_id)
      for (const g of snapshot.access.organizationGrants) db.prepare('INSERT INTO market_org_grants(plugin_id,organization_id) VALUES(?,?)').run(g.plugin_id,g.organization_id)
      for (const g of snapshot.access.directKeyGrants) db.prepare('INSERT INTO market_plugin_key_grants(plugin_id,fingerprint) VALUES(?,?)').run(g.plugin_id,g.fingerprint)
      db.exec('COMMIT')
    } catch(error) { db.exec('ROLLBACK'); throw error }
    migrate(db, migrations)
    roster.items = snapshot.catalog.items
    env.MARKET_PREVIEW_MODE = true
    env.MARKET_ORGANIZATIONS_BASE_URL = 'https://tokensapi.ai'
    // Only read the production organization directory. No production mutation routes. The
    // production market may still answer on the pre-/api/v1 route, so both are tried.
    env.MARKET_ORGANIZATIONS = process.env.MARKET_DEV_PRODUCTION_ADMIN_TOKEN ? {
      listOrganizations: async () => {
        const read = path => nativeFetch('https://market.tokensapi.ai' + path, {
          headers: { Authorization: 'Bearer ' + process.env.MARKET_DEV_PRODUCTION_ADMIN_TOKEN },
          redirect: 'error', signal: AbortSignal.timeout(15000),
        })
        let response = await read('/api/v1/organizations')
        if (response.ok) return (await response.json()).items.map(o => ({ id:o.id, name:o.name }))
        response = await read('/api/admin/access')
        if (!response.ok) throw new Error('Production directory read failed')
        return (await response.json()).organizations.map(o => ({ id:o.id, name:o.name }))
      },
    } : {}
    const assets = env.ASSETS.fetch.bind(env.ASSETS)
    env.ASSETS.fetch = async input => {
      const response = await assets(input)
      if (!(response.headers.get('content-type') || '').startsWith('text/html')) return response
      return new Response((await response.text()).replace('<main>', '<main><p class="notice" role="status">生产数据快照 · 本地预览：保存仅影响本地内存，不会修改线上，重启后重置。</p>'), {status:response.status,headers:response.headers})
    }
  } else if (!persistent) {
    // Fixtures: three organizations, one restricted plugin granted to organization 101 and to
    // one directly granted Key, whose raw value is sealed so the console can copy it back.
    restricted = roster.items.find(item => item.id === 'tokens-media-gen') ?? roster.items[0]
    if (!restricted) throw new Error('A local catalog item is required for QA')
    const fp = await fingerprint('sk-test-direct', env.MARKET_HMAC_SECRET)
    const sealed = await sealKey('sk-test-direct', 'key', fp, env)
    await env.MARKET_DB.batch([
      ...organizations.map(org => wrap('INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,?)').bind(org.id, org.name, org.id === 103 ? 0 : 1)),
      wrap("UPDATE market_plugins SET visibility='restricted',revision=revision+1 WHERE id=?").bind(restricted.id),
      wrap("INSERT INTO market_grants(plugin_id,kind,subject) VALUES(?,'org','101')").bind(restricted.id),
      wrap("INSERT INTO market_keys(fingerprint,label,encrypted_value,sealed_for,created_at) VALUES(?,?,?,'key',?)").bind(fp, '直接授权 Key · 测试', sealed, Date.now()),
      wrap("INSERT INTO market_grants(plugin_id,kind,subject) VALUES(?,'key',?)").bind(restricted.id, fp),
    ])
  }
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : input)
    // Registry responses are deterministic fixtures; unknown destinations are blocked.
    if (url.origin === 'https://registry.npmjs.org') {
      const match = /^\/-\/package\/(.+)\/dist-tags$/u.exec(url.pathname)
      const item = roster.items.find(item => item.package === (match?.[1] ?? ''))
      const doc = roster.items.find(item => url.pathname === '/'+encodeURIComponent(item.package)+'/latest')
      if(doc)return Response.json({...doc,name:doc.package,description:doc.summary})
      return item ? Response.json({ latest: item.version }) : new Response('Fixture package not found', { status: 404 })
    }
    throw new Error('External network is disabled in local market QA')
  }
  // Sign in with a real TokensAPI account: the two login lookups go to the live site, with the
  // pair the person typed and nothing else. Only those two calls leave this machine — the market
  // itself stays local and in memory, so nothing here can read or write production.
  if (LIVE_SITE) {
    const site = createTokensApiOrganizations({ MARKET_ORGANIZATIONS_BASE_URL: SITE }, nativeFetch)
    if (!site) throw new Error('MARKET_DEV_TOKENSAPI must be https://tokensapi.ai or https://dev.tokensapi.ai')
    env.MARKET_ORGANIZATIONS_BASE_URL = SITE
    // A refusal is deliberately flattened to "invalid" on the way out: the login endpoint needs
    // no identity, so telling a stranger which half was wrong would help them guess. Here the
    // person at the keyboard owns the account, so the upstream status and its own message are
    // printed — the token never is, and neither is the rest of the account payload.
    const explain = async (path, credential) => {
      try {
        const response = await nativeFetch(SITE + path, { headers: { Authorization: credential.accessToken,
          'New-Api-User': String(credential.userId), Accept: 'application/json' } })
        let message = ''
        try { message = (await response.json())?.message ?? '' } catch { message = '(响应不是 JSON)' }
        console.log(`TokensAPI ${path} 拒绝了这次登录：HTTP ${response.status}，上游说「${message}」`)
      } catch (error) { console.log(`TokensAPI ${path} 调用失败：${error.message}`) }
    }
    env.MARKET_ORGANIZATIONS = {
      ...env.MARKET_ORGANIZATIONS,
      resolveAccount: async credential => {
        const account = await site.resolveAccount(credential)
        if (!account) await explain('/api/user/self', credential)
        return account
      },
      // The local directory only knows fixture organizations, so a real one is registered as it
      // signs in. In production the platform administrator does that once with 同步组织; doing it
      // here keeps the role check honest while removing the only step a throwaway database cannot
      // supply by itself.
      resolveMyOrg: async credential => {
        const organization = await site.resolveMyOrg(credential)
        if (organization) {
          await wrap('INSERT INTO market_organizations(id,name,enabled) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name')
            .bind(organization.id, organization.name).run()
        }
        return organization
      },
    }
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
      // Lets the API reference page pre-authorize itself. Only this loopback QA server answers it; the
      // worker has no such route, so production 404s and the page falls back to a pasted credential.
      // It hands out the throwaway QA login and nothing else -- never the production admin token.
      if (incoming.url === DOCS_CREDENTIAL_PATH && incoming.method === 'GET') {
        outgoing.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        outgoing.end(CREDENTIAL); return
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
    const call = (path, data, cookie, method = data === undefined ? 'GET' : 'PUT') => nativeFetch(app.origin + path, {
      method,
      headers: { Origin: app.origin, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    const read = async (...args) => {
      const response = await call(...args)
      assert.equal(response.status, 200, args[0])
      return response.json()
    }
    assert.equal((await call('/admin/')).status, 200)
    for (const asset of ['market-admin.js', 'market-organizations.js', 'market-keys.js', 'market-users.js', 'market-grants.js', 'market-admin.css']) {
      assert.equal((await call('/admin/assets/' + asset)).status, 200, asset)
    }
    assert.equal((await call('/api/v1/audit')).status, 401)
    assert.equal((await read('/api/v1/session')).authenticated, false)
    // The API reference pre-authorizes from this QA-only path, and what it gets must really work.
    const docsCredential = await (await call(DOCS_CREDENTIAL_PATH)).text()
    assert.equal(docsCredential, CREDENTIAL)
    assert.equal((await nativeFetch(`${app.origin}/api/v1/plugins`, { headers: { Authorization: `Bearer ${docsCredential}` } })).status, 200)
    const login = await call('/api/v1/session', { credential: CREDENTIAL })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    // The console asks who it is before it draws anything, so this shape gates every panel.
    const session = await read('/api/v1/session', undefined, cookie)
    assert.equal(session.role, 'platform')
    for (const path of ['/api/v1/organizations', '/api/v1/keys', '/api/v1/audit']) await read(path, undefined, cookie)
    const id = app.restricted.id
    // What each test Key is really served by the desktop catalog.
    const visible = async apiKey => (await (await nativeFetch(`${app.origin}/roster.json`, { headers: { Authorization: `Bearer ${apiKey}` } })).json())
      .items.some(item => item.id === id)
    assert.equal(await visible('sk-test-org'), true)
    assert.equal(await visible('sk-test-direct'), true)
    assert.equal(await visible('sk-test-other'), false)
    // Clearing every grant is just a save: it leaves the access scope where the operator set it,
    // so a restricted plugin stays restricted instead of quietly becoming public.
    const before = await read(`/api/v1/plugins/${id}`, undefined, cookie)
    await read(`/api/v1/plugins/${id}/access`, { visibility: 'restricted', organizations: [101], keys: [], revision: before.revision }, cookie)
    const cleared = await read(`/api/v1/plugins/${id}`, undefined, cookie)
    assert.equal(cleared.visibility, 'restricted')
    assert.deepEqual(cleared.access, { organizations: [101], keys: [], users: [] })
    assert.equal((await read('/api/v1/audit', undefined, cookie)).items[0].action, 'plugin.access.updated')
    // A user found through TokensAPI search, registered, and granted from the user's own side.
    const [found] = (await read('/api/v1/users/search?keyword=user-a', undefined, cookie)).items
    await read(`/api/v1/users/${found.id}`, { name: found.name }, cookie)
    assert.equal(await visible('sk-test-personal'), false)
    await read(`/api/v1/users/${found.id}/grants`, { plugins: [id] }, cookie)
    assert.equal(await visible('sk-test-personal'), true)
    assert.deepEqual((await read(`/api/v1/plugins/${id}`, undefined, cookie)).access.users, [found.id])
    assert.equal((await read('/api/v1/audit', undefined, cookie)).items[0].action, 'grants.updated')
    // The TokensAPI account login: only an administrator of an organization registered and
    // enabled here gets in. A wrong pair, a plain member, an account in no organization and an
    // administrator of a disabled organization are all refused.
    const siteLogin = (accessToken, userId) => call('/api/v1/session', { tokensapi: true, accessToken, userId })
    for (const [token, userId] of [['dev-owner', 5002], ['dev-member', 5002], ['dev-outsider', 5003], ['dev-disabled', 5004]]) {
      assert.equal((await siteLogin(token, userId)).status, 401, token)
    }
    const tenant = await siteLogin('dev-owner', 5001)
    assert.equal(tenant.status, 200)
    const tenantCookie = tenant.headers.get('set-cookie').split(';')[0]
    const seat = await read('/api/v1/session', undefined, tenantCookie)
    assert.deepEqual([seat.role, seat.organizationId, seat.userId], ['organization', 101, '5001'])
    // The seat is narrowed on the server: its own organization, and nothing of the platform's.
    const offered = await read('/api/v1/organizations/101/plugins', undefined, tenantCookie)
    assert.equal(offered.items.find(item => item.id === id).visible, true)
    await read(`/api/v1/organizations/101/plugins/${id}`, { enabled: false }, tenantCookie)
    assert.equal(await visible('sk-test-org'), false)
    for (const path of ['/api/v1/organizations/102', '/api/v1/organizations', '/api/v1/plugins', '/api/v1/keys'])
      assert.equal((await call(path, undefined, tenantCookie)).status, 403, path)
    assert.equal((await call('/v1/plugins')).status, 200)
    assert.equal((await call('/server/services/auth.js')).status, 404)
    await assert.rejects(globalThis.fetch('https://tokensapi.ai/api/organizations/all'), /External network/u)
    console.log('Local market QA smoke passed: login (credential and TokensAPI account), session, organization/Key/user access, access save, user grants, organization switch, audit, catalog, and network isolation.')
  } finally { await app.close() }
}

if (process.argv.includes('--smoke')) {
  await smoke()
} else {
  const app = await start(Number(process.env.MARKET_DEV_PORT || 8788))
  console.log(`Local market QA ready: ${app.origin}/admin/`)
  console.log(process.env.MARKET_DEV_ADMIN_TOKEN ? 'Login: configured in MARKET_DEV_ADMIN_TOKEN (hidden)' : 'Fixture login: market-test')
  if (SNAPSHOT) console.log('Production metadata snapshot loaded. Local-only edits; no production writes, no copied secrets. Memory resets on restart.')
  else {
    console.log('Fixture organization Key: sk-test-org | direct Key: sk-test-direct')
    console.log(`TokensAPI console login is live against ${SITE}: sign in with your own user ID and access token. The organization it answers with is registered in this throwaway database on the way in.`)
    console.log('All organizations, credentials and packages are TEST FIXTURES. Apart from that sign-in, external network is blocked; memory data resets on restart.')
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0)) })
}
