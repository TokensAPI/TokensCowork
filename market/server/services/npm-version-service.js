import { latestVersion } from '../integrations/npm-registry.js'
import { createRegistryClient } from '../registry/client.mjs'

// Runtime version resolution only: never mutate metadata, grants or lifecycle.
export async function resolveNpmVersions(items, env = {}) {
  const versions = new Map()
  const names = [...new Set(items.filter(item => item.npm && item.state === 'published').map(item => item.package))]
  let next = 0
  await Promise.all(Array.from({length: Math.min(6, names.length)}, async () => {
    while (next < names.length) {
      const name = names[next++]
      const item = items.find(candidate => candidate.package === name)
      versions.set(name, item?.registry === 'tokenscowork'
        ? await createRegistryClient(env).latestVersion(name)
        : await latestVersion(name, ''))
    }
  }))
  return items.map(item => item.npm && item.state === 'published'
    ? {...item, npmLatestVersion: versions.get(item.package), versionMode: 'latest'} : item)
}

export async function liveCatalog(items, env = {}) {
  return (await resolveNpmVersions(items, env))
    // A failed lookup or prerelease latest must not advertise an obsolete install target.
    .filter(item => !item.npm || !!item.npmLatestVersion)
    .map(item => item.npm ? {...item, version: item.npmLatestVersion} : item)
}
