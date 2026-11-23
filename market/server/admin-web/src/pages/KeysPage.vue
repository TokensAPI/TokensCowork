<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ApiError, request } from '../api'
import { notify, runAction } from '../feedback'
import { confirmAction } from '../confirm'
import { shell, useRefresh } from '../shell'
import { useRequest } from '../useRequest'
import { loadPluginIndex, pluginName, type PluginIndexEntry } from '../plugins'
import { ICONS, viewById } from '../views'
import AppIcon from '../components/AppIcon.vue'
import PageHeader from '../components/PageHeader.vue'
import ListCard from '../components/ListCard.vue'
import RowActions from '../components/RowActions.vue'
import FormDialog from '../components/FormDialog.vue'
import GrantsDialog from '../components/GrantsDialog.vue'

/**
 * The Key page: the directory of `sk-` Keys the platform grants plugins to one by one, from here
 * or from a plugin's access dialog. A Key grant stands on its own: organizations, their switches
 * and user grants never add to or take away from it. The same page as /admin/#keys
 * (market-keys.js), on the same /api/v1/keys routes.
 */
export interface MarketKey {
  fingerprint: string
  apiKey: string | null
  label: string
  createdAt?: number
  stored?: boolean
  plugins: string[]
}
interface KeyDirectory {
  keys: MarketKey[]
  displayReady: boolean
  plugins: PluginIndexEntry[]
}

const view = viewById('keys')!
const directory = useRequest<KeyDirectory>(async () => {
  const [list, plugins] = await Promise.all([request<{ items: MarketKey[]; displayReady: boolean }>('/api/v1/keys'), loadPluginIndex()])
  return { keys: list.items, displayReady: list.displayReady, plugins }
})
const keys = computed(() => directory.data.value?.keys ?? [])
const plugins = computed(() => directory.data.value?.plugins ?? [])
const displayReady = computed(() => directory.data.value?.displayReady ?? false)

/** Reads the page; true when its answer was taken. Counts and the footer time follow. */
async function load() {
  const ok = await directory.run()
  if (ok) {
    shell.counts.keys = keys.value.length
    shell.lastRefresh = Date.now()
  }
  return ok
}
/** After a save: the page again, or a note that the save stands but the list is stale. */
async function reload(message: string) {
  if (await load()) notify(message)
  else notify(`${message} 但页面刷新失败：${directory.error.value?.message ?? ''} 请刷新核对，无需重复保存。`, 'error')
}
useRefresh(async () => {
  if (!(await load())) throw directory.error.value ?? new Error('刷新失败')
})
onMounted(load)

// Keys are named by their note, else by their own value; the internal id is never shown.
const label = (key: MarketKey) => key.label || key.apiKey || '未命名 Key'
const names = (key: MarketKey) => (key.plugins.length ? key.plugins.map((id) => pluginName(plugins.value, id)).join('、') : '—')
const note = computed(() =>
  displayReady.value
    ? `共 ${keys.value.length} 个 Key。单独授权只对这个 Key 生效，与组织、用户授权互不影响。`
    : `共 ${keys.value.length} 个 Key。未配置加密密钥，Key 原文不保存。`,
)

// ── 登记 / 改备注 ───────────────────────────────────────────────
const form = reactive({ open: false, editing: null as MarketKey | null, value: '', label: '', pending: false, error: '' })
function edit(key: MarketKey | null = null) {
  Object.assign(form, { open: true, editing: key, value: '', label: key?.label ?? '', pending: false, error: '' })
}
function closeForm() {
  form.value = ''
  form.open = false
}
const formNote = computed(() =>
  form.editing ? form.editing.apiKey || '' : displayReady.value ? 'Key 原文加密保存' : '未配置加密密钥，原文不会保存',
)
async function saveForm() {
  const editing = form.editing
  form.pending = true
  form.error = ''
  const ok = await runAction(
    () => (editing
      ? request(`/api/v1/keys/${editing.fingerprint}`, { label: form.label.trim() }, 'PATCH')
      : request('/api/v1/keys', { key: form.value.trim(), label: form.label.trim() }, 'POST')),
    { onError: (message, cause) => { if (!(cause instanceof ApiError && cause.status === 401)) form.error = message } },
  )
  form.pending = false
  if (!ok) return
  closeForm()
  await reload(editing ? '备注已保存。' : 'Key 已登记，可点「授权插件」或在插件的「访问范围」里勾选。')
}

// ── 行操作 ─────────────────────────────────────────────────────
const busy = ref<string | null>(null)
const grants = ref<InstanceType<typeof GrantsDialog>>()

async function withRow(key: MarketKey, fn: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = key.fingerprint
  try {
    await fn()
  } finally {
    busy.value = null
  }
}
function openGrants(key: MarketKey) {
  void withRow(key, () => grants.value!.show(`/api/v1/keys/${key.fingerprint}`, label(key)))
}
function copy(key: MarketKey) {
  void runAction(() => navigator.clipboard.writeText(key.apiKey ?? ''), { success: 'Key 已复制到剪贴板。' })
}
async function remove(key: MarketKey) {
  const held = key.plugins.length
    ? `它的 ${key.plugins.length} 项插件授权一并移除，只授权给这个 Key 的受限插件，持有它的人将看不到。`
    : '它目前没有单独授权的插件。'
  const confirmed = await confirmAction({
    title: `删除 Key「${label(key)}」？`,
    ok: '删除 Key',
    text: `${held}组织授权和用户授权不受影响；删除后不可恢复，需要时重新登记。`,
  })
  if (!confirmed) return
  await withRow(key, async () => {
    if (await runAction(() => request(`/api/v1/keys/${key.fingerprint}`, undefined, 'DELETE'))) await reload('Key 已删除。')
  })
}
const moreFor = (key: MarketKey) => [
  ...(key.apiKey ? [{ label: '复制 Key', run: () => copy(key) }] : []),
  { label: '改备注', run: () => edit(key) },
  'divider' as const,
  { label: '删除', danger: true, run: () => void remove(key) },
]
</script>

<template>
  <PageHeader :title="view.title" :description="view.description">
    <template #actions>
      <button class="btn btn-primary" type="button" @click="edit()"><AppIcon :paths="ICONS.plus" />登记 Key</button>
    </template>
  </PageHeader>
  <div class="page-body">
    <div class="container-fluid">
      <section aria-label="Key">
        <ListCard
          :loading="directory.loading.value"
          :ready="!!directory.data.value"
          :error="directory.error.value?.message"
          :count="keys.length"
          empty-title="暂无登记的 Key"
          empty-subtitle="登记后可在插件的「访问范围」里直接勾选。"
          @retry="load"
        >
          <template #head>
            <th scope="col">备注</th>
            <th scope="col">API Key</th>
            <th scope="col">授权插件</th>
            <th scope="col" class="w-1"><span class="visually-hidden">操作</span></th>
          </template>
          <tr v-for="key in keys" :key="key.fingerprint" :aria-busy="busy === key.fingerprint || undefined">
            <td :class="key.label ? 'fw-medium' : 'text-secondary'">{{ key.label || '未命名' }}</td>
            <td v-if="key.apiKey" class="font-monospace small text-break user-select-all">{{ key.apiKey }}</td>
            <td v-else class="text-secondary">原文未保存，需删除后重新登记</td>
            <td class="text-break">{{ names(key) }}</td>
            <td>
              <RowActions :name="label(key)" :primary="{ label: '授权插件', run: () => openGrants(key) }" :more="moreFor(key)" :disabled="busy === key.fingerprint" />
            </td>
          </tr>
          <template #footer>
            <div v-if="directory.data.value" class="card-footer text-secondary">{{ note }}</div>
          </template>
        </ListCard>
      </section>
    </div>
  </div>

  <FormDialog
    :open="form.open"
    id="key-dialog"
    :title="form.editing ? '修改备注' : '登记 Key'"
    close-label="关闭 Key 编辑"
    :pending="form.pending"
    :error="form.error"
    @submit="saveForm"
    @close="closeForm"
  >
    <div v-if="!form.editing" class="mb-3">
      <label class="form-label" for="key-value">API Key</label>
      <input id="key-value" v-model="form.value" class="form-control" type="password" autocomplete="off" spellcheck="false" maxlength="512" placeholder="sk-…" required />
    </div>
    <div class="mb-3">
      <label class="form-label" for="key-label">备注</label>
      <input id="key-label" v-model="form.label" class="form-control" maxlength="120" placeholder="例如 某客户测试 Key" />
    </div>
    <div class="form-hint text-break">{{ formNote }}</div>
  </FormDialog>

  <GrantsDialog ref="grants" :plugins="plugins" @saved="reload" />
</template>
