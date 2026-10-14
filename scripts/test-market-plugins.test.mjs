import assert from 'node:assert/strict'
import { test } from 'node:test'
import { marketBundles, parseOptions, repositoryUrl, tagCandidates } from './test-market-plugins.mjs'

test('market bundles exclude upstream runtime packages and built-in plugins', () => {
  const profile = { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@tokens/dsh-model-manager', '@tokensapi/dsh-connect', 42] } } }
  assert.deepEqual(marketBundles(profile, ['@tokens/dsh-model-manager']), ['@tokensapi/dsh-connect'])
  assert.deepEqual(marketBundles({}, []), [])
})

test('repository fields resolve to clonable URLs', () => {
  assert.equal(repositoryUrl({ repository: { url: 'git+https://github.com/a/b.git' } }), 'https://github.com/a/b.git')
  assert.equal(repositoryUrl({ repository: 'github:a/b' }), 'https://github.com/a/b.git')
  assert.equal(repositoryUrl({ repository: 'a/b' }), 'https://github.com/a/b.git')
  assert.equal(repositoryUrl({}), undefined)
})

test('source tags follow the installed version', () => {
  assert.deepEqual(tagCandidates('2.9.3'), ['v2.9.3', '2.9.3'])
})

test('a Profile directory is required', () => {
  assert.throws(() => parseOptions([]), /--profile/)
  assert.equal(parseOptions(['--profile', 'C:/p', '--plan']).plan, true)
})
