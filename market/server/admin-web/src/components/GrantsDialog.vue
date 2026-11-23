<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import FormDialog from './FormDialog.vue'
import { request, ApiError } from '../api'
import { runAction } from '../feedback'
import { grantable, type PluginIndexEntry } from '../plugins'

/**
 * The per-subject grant dialog, as at /admin/ (market-grants.js): every plugin one organization,
 * Key or user holds, ticked on one list and saved as a whole. `subject` is
 * /api/v1/{organizations|keys|users}/{id}; `who` titles the dialog and the success message. The
 * page opens it once the subject's grants are read (see open()) and reloads itself on `saved`.
 */
const props = defineProps<{ plugins: PluginIndexEntry[] }>()
const emit = defineEmits<{ saved: [message: string] }>()

const open = ref(false)
const pending = ref(false)
const error = ref('')
const search = ref('')
const subject = ref('')
const who = ref('')
const chosen = ref(new Set<string>())

const options = computed(() => grantable(props.plugins))
const visible = computed(() => {
  const term = search.value.trim().toLowerCase()
  return options.value.filter((plugin) => `${plugin.displayName} ${plugin.package} ${plugin.id}`.toLowerCase().includes(term))
})
const count = computed(() => options.value.filter((plugin) => chosen.value.has(plugin.id)).length)

function toggle(id: string, on: boolean) {
  const next = new Set(chosen.value)
  if (on) next.add(id)
  else next.delete(id)
  chosen.value = next
}

/** Reads what the subject holds, then opens. Resolves whether it opened. */
async function show(subjectPath: string, title: string) {
  return runAction(async () => {
    const current = await request<{ plugins: string[] }>(`${subjectPath}/grants`)
    subject.value = subjectPath
    who.value = title
    chosen.value = new Set(current.plugins)
    search.value = ''
    error.value = ''
    open.value = true
  })
}
async function save() {
  pending.value = true
  error.value = ''
  const ok = await runAction(() => request(`${subject.value}/grants`, { plugins: [...chosen.value] }), {
    onError: (message, cause) => {
      if (!(cause instanceof ApiError && cause.status === 401)) error.value = message
    },
  })
  pending.value = false
  if (!ok) return
  open.value = false
  emit('saved', `${who.value} 的插件授权已保存。`)
}
watch(open, (value) => {
  if (!value) chosen.value = new Set()
})
defineExpose({ show })
</script>

<template>
  <FormDialog :open="open" id="grants" kicker="授权插件" :title="who" close-label="关闭授权插件" :pending="pending" :error="error" scrollable @submit="save" @close="open = false">
    <div class="alert alert-info">勾选的受限插件对它可见。公开插件本来就所有人可见；插件的公开/受限在「插件」页设置。</div>
    <input v-model="search" class="form-control mb-2" type="search" placeholder="搜索插件名称或包名" aria-label="搜索可授权插件" />
    <div class="list-group grant-list">
      <label v-for="plugin in visible" :key="plugin.id" class="list-group-item d-flex align-items-center gap-2">
        <input type="checkbox" class="form-check-input m-0" :checked="chosen.has(plugin.id)" @change="toggle(plugin.id, ($event.target as HTMLInputElement).checked)" />
        <span class="text-break">{{ plugin.displayName }}</span>
        <span v-if="plugin.state !== 'published'" class="badge bg-secondary-lt ms-auto">未上架</span>
      </label>
      <div v-if="!visible.length" class="list-group-item text-secondary">
        {{ options.length ? '没有匹配项，已选项仍保留。' : '暂无受限插件；公开插件所有人都能用，无需授权。' }}
      </div>
    </div>
    <template #footer>
      <span class="me-auto text-secondary">已选 {{ count }} 个插件</span>
    </template>
  </FormDialog>
</template>
