<script setup lang="ts">
import { pluginName, type PluginIndexEntry } from '../plugins'

/**
 * One user's restricted plugins, each with where it comes from (granted to the user, or through an
 * organization), and TokensAPI's notice if it could not tell everything -- GET /api/v1/users/{id}/plugins.
 */
export interface UserAccess {
  id: number
  name: string
  registered: boolean
  organization: { id: number; name?: string; registered?: boolean; enabled?: boolean } | null
  items: { id: string; displayName?: string; sources: { kind: string; id?: number; name?: string }[] }[]
  notice?: string
}
defineProps<{ view: UserAccess; plugins: PluginIndexEntry[] }>()
</script>

<template>
  <div>
    <div v-for="plugin in view.items" :key="plugin.id" class="d-flex flex-wrap align-items-center gap-1">
      <span class="text-break">{{ plugin.displayName || pluginName(plugins, plugin.id) }}</span>
      <template v-for="(source, index) in plugin.sources" :key="index">
        <span v-if="source.kind === 'user'" class="badge bg-azure-lt">单独授权</span>
        <span v-else class="badge bg-yellow-lt">组织：{{ source.name || `组织 #${source.id}` }}</span>
      </template>
    </div>
    <span v-if="!view.items.length" class="text-secondary">—</span>
    <div v-if="view.notice" class="text-warning small">{{ view.notice }}</div>
  </div>
</template>
