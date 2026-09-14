import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchRegistryRoutes, patchInstallerRouting } from './market-routing-overlay.mjs';

test('shared package registry resolves each plugin and preserves individual authorization', async () => {
  const source = patchRegistryRoutes(readFileSync(new URL('../../../market/server/private-registry/routes.js', import.meta.url), 'utf8'));
  const rows = ['one', 'two'].map(id => ({ id, state: 'published', visibility: 'restricted', metadata: JSON.stringify({ package: `@tokensapi/${id}`, npm: true, registry: 'tokenscowork' }) }));
  const db = { prepare(sql) { return { bind(value) { return {
    all: async () => ({ results: rows.filter(row => JSON.parse(row.metadata).package === value).map(row => ({ id: row.id })) }),
    first: async () => rows.find(row => row.id === value),
  }; } }; } };
  const factory = new Function('reply', 'allowed', 'packageOK', 'versionOK', 'createRegistryClient', 'canServeRegistryPackage',
    source.replace(/^import .*\n/gm, '').replace('export async function registryRoute', 'async function registryRoute') + '\nreturn registryRoute');
  const route = factory((data, status = 200) => Response.json(data, { status }), async (request, env, id) => request.headers.get('authorization') === `Bearer ${id}`,
    name => /^@tokensapi\/[a-z]+$/.test(name), () => true,
    () => ({ status: () => ({ ready: true }), metadata: async name => ({ ok: true, data: { name, versions: { '1.0.0': { name, version: '1.0.0', dist: { tarball: 'https://registry.example/file.tgz' } } } } }) }), () => true);
  const env = { MARKET_DB: db, MARKET_HMAC_SECRET: 'fixture' };
  for (const id of ['one', 'two']) {
    const url = `https://market.example/registry/by-package/${encodeURIComponent('@tokensapi/' + id)}`;
    const success = await route(new Request(url, { headers: { authorization: `Bearer ${id}` } }), env);
    assert.equal(success.status, 200);
    const body = await success.json();
    assert.equal(body.name, `@tokensapi/${id}`);
    assert.ok(body.versions['1.0.0'].dist.tarball.includes(`/registry/${id}/`));
    assert.equal((await route(new Request(url), env)).status, 403);
    assert.equal((await route(new Request(url, { headers: { authorization: 'Bearer wrong' } }), env)).status, 403);
  }
  assert.equal((await route(new Request('https://market.example/registry/by-package/%40tokensapi%2Fmissing'), env)).status, 403);
});

test('installer uses shared scope URL, not a single plugin URL', () => {
  const source = 'const registry = `${this.registryOrigin}/registry/${encodeURIComponent(candidate.itemId)}/`\nconst auth = `--//${new URL(registry).host}/registry/${encodeURIComponent(candidate.itemId)}/:_authToken=${token}`';
  const patched = patchInstallerRouting(source);
  assert.ok(patched.includes('/registry/by-package/'));
  assert.ok(!patched.includes('encodeURIComponent(candidate.itemId)'));
  assert.throws(() => patchInstallerRouting(patched), /anchor changed/);
});
