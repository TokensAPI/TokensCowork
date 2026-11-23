<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { request } from '../api'
import { formatTime, shell, useRefresh } from '../shell'
import { useRequest } from '../useRequest'
import { keyLabel, loadKeys, loadOrganizations, loadUsers, organizationLabel, userLabel } from '../directory'
import { loadPluginIndex, pluginName } from '../plugins'
import { ACTIONS, actorText, factsText, targetText, type AuditEvent, type Names } from '../activity'
import { viewById } from '../views'
import PageHeader from '../components/PageHeader.vue'
import ListCard from '../components/ListCard.vue'

/**
 * The activity log (#activity): the latest management changes, each with what it was
 * made to (named from the directories, read alongside), its facts, who made it and when.
 */
const view = viewById('activity')!
const log = useRequest(async () => {
  const [audit, orgs, keys, users, plugins] = await Promise.all([
    request<{ items: AuditEvent[] }>('/api/v1/audit'), loadOrganizations(), loadKeys(), loadUsers(), loadPluginIndex(),
  ])
  const names: Names = {
    organization: (id) => organizationLabel(orgs.items, id),
    key: (fingerprint) => keyLabel(keys.items, fingerprint),
    user: (id) => userLabel(users.items, id),
    plugin: (id) => pluginName(plugins, id),
  }
  return audit.items.map((event, index) => ({
    index, title: ACTIONS[event.action] || '管理变更', target: targetText(event, names), facts: factsText(event), actor: actorText(event.actor), time: formatTime(event.createdAt),
  }))
})
const rows = computed(() => log.data.value ?? [])
async function load() {
  const ok = await log.run()
  if (ok) shell.lastRefresh = Date.now()
  return ok
}
useRefresh(async () => {
  if (!(await load())) throw log.error.value ?? new Error('刷新失败')
})
onMounted(load)
</script>

<template>
  <PageHeader :title="view.title" :description="view.description" />
  <div class="page-body">
    <div class="container-fluid">
      <section aria-label="操作记录">
        <ListCard :loading="log.loading.value" :ready="!!log.data.value" :error="log.error.value?.message" :count="rows.length" empty-title="暂无操作记录" @retry="load">
          <template #head>
            <th scope="col">操作</th>
            <th scope="col">详情</th>
            <th scope="col">操作人</th>
            <th scope="col">时间</th>
          </template>
          <tr v-for="row in rows" :key="row.index">
            <td>
              <div class="fw-medium">{{ row.title }}</div>
              <div v-if="row.target" class="text-secondary small text-break">{{ row.target }}</div>
            </td>
            <td class="text-break">{{ row.facts }}</td>
            <td class="text-secondary">{{ row.actor }}</td>
            <td class="text-secondary text-nowrap">{{ row.time }}</td>
          </tr>
          <template #footer>
            <div class="card-footer text-secondary">显示最近 100 条管理变更，服务端最多保留 5000 条，不记录 API Key 明文。</div>
          </template>
        </ListCard>
      </section>
    </div>
  </div>
</template>
