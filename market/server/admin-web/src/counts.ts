import { request } from './api'
import { shell } from './shell'
import { loadKeys, loadOrganizations, loadUsers } from './directory'

/**
 * The sidebar's counts (plugins, organizations, users, Keys), read once when a platform
 * administrator signs in, in the background; each page updates its own count whenever it loads.
 * A count that cannot be read is simply not shown.
 */
export async function loadCounts() {
  const [plugins, orgs, users, keys] = await Promise.allSettled([
    request<{ counts: { all: number } }>('/api/v1/plugins?stage=all&page=1&pageSize=10'), loadOrganizations(), loadUsers(), loadKeys(),
  ])
  if (plugins.status === 'fulfilled') shell.counts.plugins ??= plugins.value.counts.all
  if (orgs.status === 'fulfilled') shell.counts.organizations ??= orgs.value.items.length
  if (users.status === 'fulfilled') shell.counts.users ??= users.value.items.length
  if (keys.status === 'fulfilled') shell.counts.keys ??= keys.value.items.length
}
