import { request } from './api'

/** One entry of GET /api/v1/plugins?view=index: every market plugin's name, state and scope. */
export interface PluginIndexEntry {
  id: string
  displayName: string
  package: string
  state: string
  visibility: 'public' | 'restricted'
  category: string
}

export const loadPluginIndex = async () => (await request<{ items: PluginIndexEntry[] }>('/api/v1/plugins?view=index')).items

/** A plugin's name, else its id (a plugin removed since, or not loaded yet). */
export const pluginName = (index: PluginIndexEntry[], id: string) => index.find((plugin) => plugin.id === id)?.displayName || id

/**
 * What a grant can name: built-in components are the application's, a trashed plugin cannot be
 * granted, and a public plugin is open to everyone already. Grants kept on a public plugin stay
 * untouched on save and apply again once it is restricted.
 */
export const grantable = (index: PluginIndexEntry[]) =>
  index.filter((plugin) => plugin.category !== 'builtin' && plugin.state !== 'deleted' && plugin.visibility !== 'public')

/** A plugin's state as the console names and colours it (badge bg-<colour>-lt). */
export const STATES: Record<string, [string, string]> = {
  builtin: ['内置', 'azure'], draft: ['草稿', 'secondary'], published: ['已上架', 'green'], archived: ['已下架', 'yellow'], deleted: ['回收站', 'red'],
}
export const STATE_NAMES: Record<string, string> = Object.fromEntries(Object.entries(STATES).map(([state, [name]]) => [state, name]))
