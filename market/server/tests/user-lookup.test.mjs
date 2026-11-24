// A TokensAPI user asked by number. TokensAPI's search matches the keyword anywhere, so user 3 is
// one of many matches for 「3」 and may sit past the first page; the lookup reads on until the id
// itself turns up or every match has been seen, up to a page limit.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokensApiUser, organizationMember, USER_LOOKUP_PAGES } from '../services/organizations.js'

/** A fake TokensAPI search over `users`, matching the keyword anywhere in the id, as TokensAPI does. */
function site(users) {
  const calls = []
  const searchUsers = async (keyword, page, size) => {
    calls.push({ keyword, page, size })
    const matches = users.filter(user => String(user.id).includes(keyword))
    return { items: matches.slice((page - 1) * size, page * size), total: matches.length }
  }
  return { env: { MARKET_ORGANIZATIONS: { searchUsers } }, calls }
}
const user = (id, organizationId = null) => ({ id, name: `用户${id}`, username: `u${id}`, organizationId })
// 「3」 matches 13, 23, 30 … long before it matches 3 itself.
const crowd = (count, last) => [...Array.from({ length: count }, (_, i) => user(1000 + i * 10 + 3)), last].filter(Boolean)

test('a user on the first page is found with one request', async () => {
  const { env, calls } = site([user(3, 7), user(13), user(30)])
  assert.deepEqual(await tokensApiUser(env, 3), { id: 3, name: '用户3', organizationId: 7 })
  assert.deepEqual(calls, [{ keyword: '3', page: 1, size: 100 }])
})

test('a user past the first page is found on the page they are on', async () => {
  const { env, calls } = site(crowd(100, user(3, 7)))
  assert.deepEqual(await tokensApiUser(env, 3), { id: 3, name: '用户3', organizationId: 7 })
  assert.deepEqual(calls.map(call => call.page), [1, 2])
  // The organization check that relies on it (an organization administrator naming members) agrees.
  assert.deepEqual(await organizationMember(env, 7, 3), { id: 3, name: '用户3' })
})

test('a user TokensAPI does not have is not found once every match has been read', async () => {
  const { env, calls } = site(crowd(250))
  assert.equal(await tokensApiUser(env, 3), null)
  assert.deepEqual(calls.map(call => call.page), [1, 2, 3])
  const none = site([])
  assert.equal(await tokensApiUser(none.env, 3), null)
  assert.equal(none.calls.length, 1)
})

test('past the page limit the user is treated as not found, and that is logged', async t => {
  const warned = []
  t.mock.method(console, 'warn', message => warned.push(message))
  const { env, calls } = site(crowd(USER_LOOKUP_PAGES * 100 + 50, user(3, 7)))
  assert.equal(await tokensApiUser(env, 3), null)
  assert.equal(calls.length, USER_LOOKUP_PAGES)
  assert.match(warned.join('\n'), /TokensAPI user 3 not found within 10 pages/u)
})

test('an upstream failure is an error, never 「not found」', async () => {
  let page = 0
  const env = { MARKET_ORGANIZATIONS: { searchUsers: async () => {
    if (++page === 2) throw new Error('down')
    return { items: crowd(100).slice(0, 100), total: 300 }
  } } }
  await assert.rejects(() => tokensApiUser(env, 3), { status: 503 })
})
