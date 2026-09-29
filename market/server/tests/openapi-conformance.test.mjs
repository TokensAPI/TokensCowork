import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import worker from '../_worker.js'
import { createAssets } from '../runtime/adapters.mjs'
import { fingerprint } from '../security/key-fingerprint.js'

// The published OpenAPI document is a second description of the management API, so it can drift away
// from the router silently. These tests pin it from three sides: every documented operation must
// reach a real handler, every resource the router matches on must be documented, and every response
// the fixture can produce must match the schema the document promises for it -- including having no
// field the document does not mention. A route or a field added without the document is a red test.
const document = () => JSON.parse(readFileSync(new URL('../admin/assets/openapi.json', import.meta.url), 'utf8'))

const resolve = (spec, node) => (node?.$ref ? node.$ref.slice(2).split('/').reduce((at, key) => at[key], spec) : node)

// A validator for exactly the JSON Schema subset this document uses. Zero dependencies is a rule
// here, and a hand-rolled checker that refuses unknown keywords is safer than one that ignores them.
const KNOWN = ['type', 'required', 'properties', 'items', 'enum', 'const', 'allOf', 'oneOf', 'description',
  'examples', 'example', 'format', 'pattern', 'minimum', '$ref']

function check(spec, schema, value, where, problems, strict = true) {
  const node = resolve(spec, schema)
  if (!node) return
  for (const keyword of Object.keys(node)) {
    if (!KNOWN.includes(keyword)) problems.push(`${where}: document uses unsupported keyword '${keyword}'`)
  }
  if (node.oneOf) {
    // A branch matches when it produces no problem of its own.
    if (!node.oneOf.some(branch => { const inner = []; check(spec, branch, value, where, inner); return !inner.length })) {
      problems.push(`${where}: matches none of the documented alternatives`)
    }
    return
  }
  if (node.allOf) {
    // Each branch only describes part of the object, so none of them may judge the whole on its own.
    for (const branch of node.allOf) check(spec, branch, value, where, problems, false)
    // Strictness has to span the branches: the union of their properties is the allowed set.
    const allowed = node.allOf.flatMap(branch => Object.keys(resolve(spec, branch).properties ?? {}))
    if (strict && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) problems.push(`${where}.${key}: present in the response, absent from the document`)
      }
    }
    return
  }
  const types = [node.type].flat().filter(Boolean)
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number'
    ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value
  if (types.length && !types.includes(actual) && !(types.includes('number') && actual === 'integer')) {
    problems.push(`${where}: documented as ${types.join('|')}, got ${actual}`)
  }
  if (node.const !== undefined && value !== node.const) problems.push(`${where}: documented as const ${node.const}, got ${value}`)
  if (node.enum && !node.enum.includes(value)) problems.push(`${where}: '${value}' is outside the documented enum`)
  if (actual === 'array' && node.items) value.forEach((item, index) => check(spec, node.items, item, `${where}[${index}]`, problems))
  if (actual !== 'object') return
  for (const key of node.required ?? []) {
    if (!(key in value)) problems.push(`${where}.${key}: documented as required, missing from the response`)
  }
  for (const [key, entry] of Object.entries(value)) {
    const property = node.properties?.[key]
    if (!property) { if (strict && node.properties) problems.push(`${where}.${key}: present in the response, absent from the document`) }
    else check(spec, property, entry, `${where}.${key}`, problems)
  }
}


// One published restricted plugin granted to organization 7, one registered Key, one registered
// user, and a TokensAPI provider that knows a single organization administrator (user 501 of organization 7).
async function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  const migrations = new URL('../database/migrations/', import.meta.url)
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'))
  t.after(() => db.close())
  const metadata = { id: 'beta', category: 'optional', package: '@fixture/beta', displayName: 'Beta', summary: 'Fixture plugin',
    repository: 'https://github.com/fixture/beta', version: '1.0.0', npm: false, installSource: { kind: 'github', commit: 'a'.repeat(40) } }
  db.prepare("INSERT INTO market_plugins(id,visibility,state,metadata,version_mode,reviewed_version) VALUES('beta','restricted','published',?,'pinned','1.0.0')").run(JSON.stringify(metadata))
  db.prepare("INSERT INTO market_organizations(id,name,enabled) VALUES(7,'Seven',1),(9,'Nine',1)").run()
  db.prepare("INSERT INTO market_grants(plugin_id,kind,subject) VALUES('beta','org','7')").run()
  db.prepare("INSERT INTO market_users(id,name) VALUES(102,'Alice')").run()
  const wrap = (sql, values = []) => ({
    bind: (...next) => wrap(sql, next),
    first: async () => db.prepare(sql).get(...values),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
    run: async () => db.prepare(sql).run(...values),
  })
  const env = {
    MARKET_ADMIN_TOKEN: 'fixture-admin', MARKET_HMAC_SECRET: 'fixture-hmac', MARKET_KEY_ENCRYPTION_SECRET: 'fixture-vault',
    MARKET_DB: { prepare: wrap, batch: async statements => {
      db.exec('BEGIN')
      try { const results = []; for (const s of statements) results.push(await s.run()); db.exec('COMMIT'); return results }
      catch (error) { db.exec('ROLLBACK'); throw error }
    } },
    ASSETS: createAssets(resolvePath(fileURLToPath(new URL('..', import.meta.url)))),
    MARKET_ORGANIZATIONS: {
      listOrganizations: async () => [{ id: 7, name: 'Seven' }, { id: 9, name: 'Nine' }],
      resolveOrganization: async key => key === 'sk-seven' ? { id: 7, name: 'Seven' } : null,
      searchUsers: async () => ({ items: [{ id: 102, name: 'Alice', username: 'alice', organizationId: 7 }], total: 1 }),
      resolveAccount: async c => c.userId === 501 ? { id: 501, displayName: 'Owner' } : null,
      resolveMyOrg: async c => c.userId === 501 ? { id: 7, name: 'Seven', role: 100 } : null,
    },
  }
  const call = async (method, path, { data, token = 'fixture-admin', cookie } = {}) => {
    const response = await worker.fetch(new Request('https://market.test' + path, {
      method,
      headers: { Origin: 'https://market.test', ...(token && !cookie ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }), env, {})
    const raw = await response.text()
    let json = null
    try { json = JSON.parse(raw) } catch {}
    return { status: response.status, json, headers: response.headers }
  }
  const tenant = (await call('PUT', '/api/v1/session', { token: null, data: { tokensapi: true, accessToken: 'owner', userId: 501 } }))
    .headers.get('set-cookie').split(';')[0]
  const { json: { fingerprint: key } } = await call('POST', '/api/v1/keys', { data: { key: 'sk-direct', label: 'Direct' } })
  assert.equal(key, await fingerprint('sk-direct', 'fixture-hmac'))
  return { db, call, tenant, key }
}

test('every operation in the OpenAPI document reaches a real route', async t => {
  const { db, call, key } = await fixture(t)
  const before = db.prepare("SELECT * FROM market_plugins WHERE id='beta'").get()
  const paths = Object.entries(document().paths)
  assert.equal(paths.length, 25)
  let checked = 0
  for (const [template, item] of paths) {
    const path = '/api/v1' + template.replace('{pluginId}', 'beta').replace('{orgId}', '7').replace('{fingerprint}', key).replace('{userId}', '102')
    for (const method of Object.keys(item).filter(name => name !== 'parameters')) {
      // Deleting the fixture Key or the session is a real change rather than a probe. Every plugin
      // write carries a stale revision, so the optimistic lock rejects it without changing anything.
      if (method === 'delete') continue
      const { status } = await call(method.toUpperCase(), path, method === 'get' ? {} : { data: { revision: 999999 } })
      assert.ok(![404, 405].includes(status), `${method.toUpperCase()} ${template} → ${status}`)
      checked++
    }
  }
  assert.equal(checked, 35)
  assert.deepEqual(db.prepare("SELECT * FROM market_plugins WHERE id='beta'").get(), before)
})

test('every resource the router matches on is documented', () => {
  const source = readFileSync(new URL('../routes/api.js', import.meta.url), 'utf8')
  const segments = new Set(Object.keys(document().paths).flatMap(path => path.split('/').filter(Boolean)))
  // The dispatch chain compares path segments against string literals, and the lifecycle verbs live
  // in one allowlist. Both are the router's public surface, so both must appear in the document.
  const matched = [...source.matchAll(/(?:head|second|third) === '([\w-]+)'/gu)].map(match => match[1])
  const lifecycle = source.match(/\['publish',[^\]]*\]/u)[0].match(/'([\w-]+)'/gu).map(quoted => quoted.slice(1, -1))
  assert.equal(lifecycle.length, 5)
  // The session resource is matched on its full path before dispatch.
  assert.match(source, /url\.pathname === '\/api\/v1\/session'/u)
  const surface = new Set([...matched, ...lifecycle, 'session'])
  for (const name of surface) assert.ok(segments.has(name), `router matches '${name}' but no documented path has that segment`)
  // Path parameters are the only segments the document may hold that no literal comparison covers.
  for (const segment of segments) assert.ok(segment.startsWith('{') || surface.has(segment), segment)
})

test('what the routes actually answer matches the schema documented for it', async t => {
  const { call, tenant, key } = await fixture(t)
  const spec = document()
  const problems = []
  // Every response the fixture can drive, read against the schema the document names for that exact
  // path, method and status. The schema is looked up in the document, never restated here, so a
  // renamed or added field fails until the document catches up. The last column is the caller:
  // omitted for the admin token, null for nobody, or an organization administrator's cookie.
  const probes = [
    ['GET', '/session', '/session', 200, undefined, null],
    ['GET', '/session', '/session', 200],
    ['GET', '/session', '/session', 200, undefined, tenant],
    ['PUT', '/session', '/session', 401, { credential: 'wrong' }, null],
    ['GET', '/plugins', '/plugins', 200],
    ['GET', '/plugins/beta', '/plugins/{pluginId}', 200],
    ['GET', '/plugins/nope', '/plugins/{pluginId}', 404],
    ['POST', '/plugins', '/plugins', 400, {}],
    ['PATCH', '/plugins/beta', '/plugins/{pluginId}', 409, { revision: 0, metadata: {} }],
    ['PUT', '/plugins/beta/access', '/plugins/{pluginId}/access', 200, { visibility: 'restricted', organizations: [7], keys: [key], revision: 1 }],
    ['PUT', '/plugins/beta/access', '/plugins/{pluginId}/access', 400, { visibility: 'everyone', revision: 2 }],
    ['POST', '/plugins/beta/archive', '/plugins/{pluginId}/archive', 409, { revision: 0 }],
    ['GET', '/organizations', '/organizations', 200],
    ['POST', '/organizations/sync', '/organizations/sync', 200, {}],
    ['GET', '/organizations/7', '/organizations/{orgId}', 200],
    ['PUT', '/organizations/7', '/organizations/{orgId}', 200, { name: 'Seven', enabled: true }],
    ['PUT', '/organizations/7', '/organizations/{orgId}', 400, {}],
    ['GET', '/organizations/7/plugins', '/organizations/{orgId}/plugins', 200],
    ['GET', '/organizations/7/plugins', '/organizations/{orgId}/plugins', 200, undefined, tenant],
    ['PUT', '/organizations/7/plugins/beta', '/organizations/{orgId}/plugins/{pluginId}', 200, { enabled: false }, tenant],
    ['PUT', '/organizations/7/plugins/beta', '/organizations/{orgId}/plugins/{pluginId}', 400, {}],
    ['GET', '/organizations/7/members?keyword=al', '/organizations/{orgId}/members', 200, undefined, tenant],
    ['GET', '/organizations/7/members', '/organizations/{orgId}/members', 400],
    ['PUT', '/organizations/7/plugins/beta', '/organizations/{orgId}/plugins/{pluginId}', 200, { members: [102] }, tenant],
    ['GET', '/organizations/7/plugins', '/organizations/{orgId}/plugins', 200],
    ['PUT', '/organizations/7/plugins/beta', '/organizations/{orgId}/plugins/{pluginId}', 200, { members: [] }],
    ['GET', '/keys', '/keys', 200],
    ['POST', '/keys', '/keys', 409, { key: 'sk-direct' }],
    ['GET', `/keys/${key}`, '/keys/{fingerprint}', 200],
    ['PATCH', `/keys/${key}`, '/keys/{fingerprint}', 200, { label: 'Renamed' }],
    ['GET', '/organizations/7/grants', '/organizations/{orgId}/grants', 200],
    ['GET', '/organizations/7/grants', '/organizations/{orgId}/grants', 200, undefined, tenant],
    ['PUT', '/organizations/7/grants', '/organizations/{orgId}/grants', 200, { plugins: ['beta'] }],
    ['PUT', '/organizations/7/grants', '/organizations/{orgId}/grants', 403, { plugins: [] }, tenant],
    ['PUT', '/organizations/7/grants', '/organizations/{orgId}/grants', 400, { plugins: ['nope'] }],
    ['GET', `/keys/${key}/grants`, '/keys/{fingerprint}/grants', 200],
    ['PUT', `/keys/${key}/grants`, '/keys/{fingerprint}/grants', 200, { plugins: ['beta'] }],
    ['GET', '/users', '/users', 200],
    ['GET', '/users/search?keyword=al', '/users/search', 200],
    ['GET', '/users/search', '/users/search', 400],
    ['PUT', '/users/103', '/users/{userId}', 200, { name: 'Bob' }],
    ['GET', '/users/102', '/users/{userId}', 200],
    ['GET', '/users/999', '/users/{userId}', 404],
    ['PUT', '/users/102/grants', '/users/{userId}/grants', 200, { plugins: ['beta'] }],
    ['GET', '/users/102/grants', '/users/{userId}/grants', 200],
    ['GET', '/users/999/grants', '/users/{userId}/grants', 404],
    ['GET', '/plugins/beta', '/plugins/{pluginId}', 200],
    ['DELETE', '/users/103', '/users/{userId}', 200],
    ['GET', '/audit', '/audit', 200],
    // An organization administrator's session is how 403 is reached at all.
    ['GET', '/plugins', '/plugins', 403, undefined, tenant],
    ['GET', '/organizations/9', '/organizations/{orgId}', 403, undefined, tenant],
    ['DELETE', `/keys/${key}`, '/keys/{fingerprint}', 200],
    ['DELETE', '/session', '/session', 200, undefined, tenant],
  ]
  for (const [method, path, template, expected, data, session] of probes) {
    const auth = session === undefined ? {} : session === null ? { token: null } : { cookie: session }
    const { status, json } = await call(method, '/api/v1' + path, { ...(data === undefined ? {} : { data }), ...auth })
    assert.equal(status, expected, `${method} ${path} → ${status} ${JSON.stringify(json)}`)
    const schema = spec.paths[template][method.toLowerCase()].responses[String(expected)]
    assert.ok(schema, `${method} ${template} does not document ${expected}`)
    const documented = resolve(spec, schema).content['application/json'].schema
    check(spec, documented, json, `${method} ${template} ${expected}`, problems)
  }
  // 401 is the same envelope everywhere.
  const unauthorized = await call('GET', '/api/v1/plugins', { token: 'wrong' })
  assert.equal(unauthorized.status, 401)
  check(spec, { $ref: '#/components/schemas/Error' }, unauthorized.json, '401', problems)
  assert.deepEqual(problems, [])
})
