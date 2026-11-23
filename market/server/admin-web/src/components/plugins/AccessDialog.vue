<script setup lang="ts">
import { computed, reactive } from 'vue'
import FormDialog from '../FormDialog.vue'
import CheckList from './CheckList.vue'
import { ApiError, request } from '../../api'
import { runAction } from '../../feedback'
import { confirmDiscard } from '../../confirm'
import type { MarketPlugin } from '../../plugins'
import type { Organization, MarketUser } from '../../directory'
import type { MarketKey } from '../../pages/KeysPage.vue'

/**
 * A plugin's access scope, as at /admin/ (market-plugins.js): public, or restricted to the ticked
 * organizations, Keys and users -- saved in one write against the plugin's revision. Closing it with
 * changes asks first (and so does leaving the page; see dirty()).
 */
const props = defineProps<{ organizations: Organization[]; keys: MarketKey[]; users: MarketUser[] }>()
const emit = defineEmits<{ saved: [message: string] }>()

const state = reactive({
  open: false, plugin: null as MarketPlugin | null, visibility: 'restricted' as 'public' | 'restricted',
  orgs: new Set<number>(), keys: new Set<string>(), users: new Set<number>(), baseline: '', pending: false, error: '', serial: 0,
})
const draft = () => JSON.stringify([state.visibility, [...state.orgs].sort(), [...state.keys].sort(), [...state.users].sort()])
/** Whether the open dialog holds changes not saved yet. */
const dirty = () => state.open && draft() !== state.baseline

function open(plugin: MarketPlugin) {
  Object.assign(state, {
    open: true, plugin, visibility: plugin.visibility, orgs: new Set(plugin.access?.organizations ?? []), keys: new Set(plugin.access?.keys ?? []),
    users: new Set(plugin.access?.users ?? []), pending: false, error: '', serial: state.serial + 1,
  })
  state.baseline = draft()
}
async function close() {
  if (state.pending) return
  if (dirty() && !(await confirmDiscard())) return
  state.open = false
}
const summary = computed(() =>
  state.visibility === 'public'
    ? '公开 · 所有人可见（下方授权保留，暂不起作用）'
    : state.orgs.size || state.keys.size || state.users.size
      ? `受限 · ${state.orgs.size} 个组织 · ${state.keys.size} 个 Key · ${state.users.size} 个用户`
      : '受限 · 暂无任何授权，无人可见',
)
const orgOptions = computed(() => props.organizations.map((org) => ({ value: org.id, text: `${org.name} (#${org.id})`, note: org.enabled ? '' : '已停用' })))
const keyOptions = computed(() => props.keys.map((key) => ({ value: key.fingerprint, text: [key.label, key.apiKey].filter(Boolean).join(' · ') || '未命名 Key' })))
const userOptions = computed(() => props.users.map((user) => ({ value: user.id, text: `${user.name} (#${user.id})` })))

async function save() {
  const p = state.plugin!
  state.pending = true
  state.error = ''
  const ok = await runAction(
    () => request(`/api/v1/plugins/${encodeURIComponent(p.id)}/access`, { visibility: state.visibility, organizations: [...state.orgs], keys: [...state.keys], users: [...state.users], revision: p.revision }),
    { onError: (message, cause) => { if (!(cause instanceof ApiError && cause.status === 401)) state.error = message } },
  )
  state.pending = false
  if (!ok) return
  state.open = false
  emit('saved', `${p.displayName} 的访问范围已保存。`)
}
defineExpose({ open, dirty })
</script>

<template>
  <FormDialog
    :open="state.open"
    id="plugin"
    :title="`访问范围 · ${state.plugin?.displayName ?? ''}`"
    :subtitle="state.plugin?.package ?? ''"
    close-label="关闭访问范围"
    size="lg"
    scrollable
    :pending="state.pending"
    :error="state.error"
    @submit="save"
    @close="close"
  >
    <div class="alert alert-info">
      公开插件所有人可见。受限插件只对下面勾选的组织（且该组织没有自行关闭）、勾选的 Key 或勾选的用户可见，任一命中即可。保存不会改变上架状态。
      访问范围控制本市场的展示与自建 Registry 下载；公开 npm / GitHub 包仍可从原地址下载。
    </div>
    <div class="mb-4" role="radiogroup" aria-label="访问范围">
      <label class="form-check"><input v-model="state.visibility" class="form-check-input" type="radio" name="plugin-visibility" value="public" /><span class="form-check-label">公开 · 所有人可见</span></label>
      <label class="form-check"><input v-model="state.visibility" class="form-check-input" type="radio" name="plugin-visibility" value="restricted" /><span class="form-check-label">受限 · 仅下列组织、Key 或用户可见</span></label>
    </div>
    <div class="mb-4">
      <CheckList :key="state.serial" title="组织" :options="orgOptions" :chosen="state.orgs" placeholder="搜索组织名称或 ID" search-label="搜索可选组织" empty="暂无组织。请先同步组织名录。" />
    </div>
    <div class="mb-4">
      <CheckList :key="state.serial" title="Key" :options="keyOptions" :chosen="state.keys" placeholder="搜索 Key 备注或原文" search-label="搜索可选 Key" empty="暂无登记的 Key。" />
      <div class="form-hint">新的 Key 请先在「Key」页登记。</div>
    </div>
    <div>
      <CheckList :key="state.serial" title="用户" :options="userOptions" :chosen="state.users" placeholder="搜索用户名称或 ID" search-label="搜索可选用户" empty="暂无用户。请先在「用户」页添加。" />
      <div class="form-hint">用户授权对该用户名下所有 Key 生效。新用户请先在「用户」页添加。</div>
    </div>
    <template #footer>
      <div class="me-auto min-w-0">
        <div class="text-secondary small">保存后的访问范围</div>
        <div class="fw-medium">{{ summary }}</div>
      </div>
    </template>
  </FormDialog>
</template>
