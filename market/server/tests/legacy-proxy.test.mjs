import { test } from 'node:test'
import assert from 'node:assert/strict'
import proxy from '../../legacy/_worker.js'

test('legacy preserves authorization, capabilities and same-origin tarballs', async () => {
  const saved = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(url.origin, 'https://market.tokensapi.ai')
    assert.equal(init.headers.get('authorization'), 'Bearer fixture')
    assert.equal(init.headers.get('x-dsh-catalog-registries'), 'tokenscowork')
    return Response.json({versions:{'1.0.0':{dist:{tarball:'https://market.tokensapi.ai/registry/test/pkg/1.0.0/tarball'}}}})
  }
  try {
    const result = await proxy.fetch(new Request('https://tokenscowork-market.pages.dev/registry/test/pkg', {headers:{authorization:'Bearer fixture','x-dsh-catalog-registries':'tokenscowork'}}), {})
    assert.equal((await result.json()).versions['1.0.0'].dist.tarball, 'https://tokenscowork-market.pages.dev/registry/test/pkg/1.0.0/tarball')
  } finally { globalThis.fetch = saved }
})

test('legacy manifest stays local and admin moves to the single management site', async () => {
  const result = await proxy.fetch(new Request('https://tokenscowork-market.pages.dev/source.json'), {ASSETS:{fetch: async () => Response.json({transport:{endpoint:'https://tokenscowork-market.pages.dev/v1/plugins'}})}})
  assert.equal((await result.json()).transport.endpoint,'https://tokenscowork-market.pages.dev/v1/plugins')
  const admin = await proxy.fetch(new Request('https://tokenscowork-market.pages.dev/admin/'), {})
  assert.equal(admin.headers.get('location'), 'https://market.tokensapi.ai/admin/')
})
