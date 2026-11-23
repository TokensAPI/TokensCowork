<script setup lang="ts">
import { computed, reactive } from 'vue'
import FormDialog from '../FormDialog.vue'
import { ApiError, request } from '../../api'
import { runAction } from '../../feedback'
import type { MarketPlugin } from '../../plugins'

/**
 * A plugin's state change): publish, archive,
 * move to the bin, restore as a draft, or purge -- each explained first. Publishing a public plugin
 * needs its box ticked; purging needs the plugin's id typed out.
 */
export type Operation = 'publish' | 'archive' | 'trash' | 'restore' | 'purge'
const emit = defineEmits<{ saved: [message: string] }>()
const LABELS: Record<Operation, string> = { publish: '上架插件', archive: '下架插件', trash: '移入回收站', restore: '恢复为草稿', purge: '彻底删除' }

const state = reactive({ open: false, plugin: null as MarketPlugin | null, operation: 'publish' as Operation, isPublic: false, confirmPublic: false, confirmId: '', pending: false, error: '' })
const danger = computed(() => state.operation === 'purge' || state.operation === 'trash')
const status = computed(() => (danger.value ? 'bg-danger' : state.operation === 'archive' ? 'bg-warning' : 'bg-primary'))
const description = computed(() => {
  const plugin = state.plugin
  return {
    publish: state.isPublic
      ? '此插件将对所有人公开。若仅给指定组织使用，请先取消并配置访问范围。'
      : (['organizations', 'keys', 'users'] as const).some((kind) => plugin?.access?.[kind]?.length)
        ? '此插件受限，将按已保存的组织、Key 或用户授权上架。'
        : '此插件受限，还没有授权任何组织、Key 或用户：上架后暂时无人可见，之后在「访问范围」里授权即可。',
    archive: '下架后不再出现在市场，也不能通过市场私有下载入口下载。不会卸载用户已经安装的插件。',
    trash: '移入回收站后不再展示。插件资料和授权关系保留，可恢复为草稿；不会删除外部 npm 包。',
    restore: '恢复后仍是草稿，不会立即公开。原授权关系保持不变。',
    purge: '不可恢复：删除市场资料及该插件的组织、Key 授权，保留操作记录。不删除 npm 包或用户已安装的插件。彻底删除后此 ID 可重新使用。',
  }[state.operation]
})

function open(plugin: MarketPlugin, operation: Operation, isPublic: boolean) {
  Object.assign(state, { open: true, plugin, operation, isPublic, confirmPublic: false, confirmId: '', pending: false, error: '' })
}
async function submit() {
  const { plugin, operation } = state
  if (!plugin) return
  if (operation === 'purge' && state.confirmId !== plugin.id) {
    state.error = '请输入完整插件 ID 确认彻底删除'
    return
  }
  state.pending = true
  state.error = ''
  const ok = await runAction(
    () => request(`/api/v1/plugins/${encodeURIComponent(plugin.id)}/${operation}`, {
      revision: plugin.revision,
      ...(operation === 'purge' ? { confirmId: state.confirmId } : {}),
      ...(operation === 'publish' ? { confirmPublic: state.confirmPublic } : {}),
    }, 'POST'),
    { onError: (message, cause) => { if (!(cause instanceof ApiError && cause.status === 401)) state.error = message } },
  )
  state.pending = false
  if (!ok) return
  state.open = false
  emit('saved', LABELS[operation] + '成功。')
}
defineExpose({ open })
</script>

<template>
  <FormDialog
    :open="state.open"
    id="lifecycle"
    :title="`${LABELS[state.operation]} · ${state.plugin?.displayName ?? ''}`"
    close-label="取消状态变更"
    :status="status"
    :submit-label="LABELS[state.operation]"
    :submit-class="danger ? 'btn-danger' : 'btn-primary'"
    :pending="state.pending"
    :error="state.error"
    @submit="submit"
    @close="state.open = false"
  >
    <p class="text-secondary">{{ description }}</p>
    <div v-if="state.operation === 'publish' && state.isPublic">
      <label class="form-check"><input v-model="state.confirmPublic" class="form-check-input" type="checkbox" required /><span class="form-check-label">确认向所有用户公开上架</span></label>
    </div>
    <div v-if="state.operation === 'purge'">
      <label class="form-label" for="purge-confirm-id">请输入插件 ID 确认：<code>{{ state.plugin?.id }}</code></label>
      <input id="purge-confirm-id" v-model="state.confirmId" class="form-control" autocomplete="off" spellcheck="false" maxlength="80" required />
    </div>
  </FormDialog>
</template>
