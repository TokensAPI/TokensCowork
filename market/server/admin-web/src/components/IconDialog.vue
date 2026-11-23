<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import FormDialog from './FormDialog.vue'
import { ApiError, request } from '../api'
import { runAction } from '../feedback'
import { confirmAction } from '../confirm'
import { prepareIcon } from '../lib/icon.js'

/**
 * The plugin icon dialog, opened from the plugin page and the
 * documentation page. There is one icon per plugin, served at /v1/icons/{id}: the console, the docs
 * center and the desktop market's cards all draw that same image. The server keeps only PNG, JPEG or
 * WebP up to 256 KB; any other image the browser can draw, or one too large, is redrawn here into a
 * PNG no wider than 512 pixels before it is uploaded (prepareIcon). A picked file is previewed as a
 * data: URL, which the console's CSP allows for images.
 */
interface Target {
  id: string
  displayName?: string
  package?: string
}
interface Prepared {
  blob: Blob
  contentType: string
  width: number
  height: number
  converted: boolean
}
const emit = defineEmits<{ saved: [message: string] }>()

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('无法读取这个文件。'))
    reader.readAsDataURL(blob)
  })
async function base64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const state = reactive({
  open: false, target: null as Target | null, current: '', hasIcon: false, chosen: null as Prepared | null, preview: '', info: '', error: '', pending: false,
})
const file = ref<HTMLInputElement>()
const name = computed(() => state.target?.displayName || state.target?.id || '')

/** Opens the dialog for one market plugin; `saved` is emitted once a change is stored. */
function open(target: Target) {
  Object.assign(state, { open: true, target, hasIcon: false, chosen: null, preview: '', info: '', error: '', pending: false })
  // The current icon is read where everyone reads it; a plugin without one answers 404.
  state.current = `/v1/icons/${encodeURIComponent(target.id)}?t=${Date.now()}`
}
function pick() {
  if (state.pending || !file.value) return
  file.value.value = ''
  file.value.click()
}
async function picked() {
  const chosen = file.value?.files?.[0]
  if (!chosen) return
  Object.assign(state, { error: '', chosen: null, preview: '', info: `${chosen.name} · ${size(chosen.size)}` })
  let prepared: Prepared
  try {
    prepared = (await prepareIcon(chosen)) as Prepared
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    state.info = ''
    return
  }
  state.chosen = prepared
  state.preview = await dataUrl(prepared.blob)
  state.info = `${chosen.name} · ${prepared.width}×${prepared.height} · ` +
    (prepared.converted ? `已转换为 PNG（${size(prepared.blob.size)}）` : `${prepared.contentType.slice(6).toUpperCase()} ${size(prepared.blob.size)}，原样保存`)
}
const onError = (message: string, cause: unknown) => {
  if (!(cause instanceof ApiError && cause.status === 401)) state.error = message
}
async function save() {
  const target = state.target, icon = state.chosen
  if (!target || !icon) return
  state.pending = true
  state.error = ''
  const ok = await runAction(async () => request(`/api/v1/plugins/${encodeURIComponent(target.id)}/icon`, { contentType: icon.contentType, data: await base64(icon.blob) }, 'PUT'), { onError })
  state.pending = false
  if (!ok) return
  close()
  emit('saved', `${target.displayName || target.id} 的图标已更新，插件市场和文档中心显示同一张图。`)
}
async function remove() {
  const target = state.target
  if (!target || !state.hasIcon || state.pending) return
  if (!(await confirmAction({ title: `移除「${target.displayName || target.id}」的图标？`, ok: '移除图标', text: '插件市场卡片、文档中心和后台都会改回显示首字，直到重新上传图标。' }))) return
  state.pending = true
  state.error = ''
  const ok = await runAction(() => request(`/api/v1/plugins/${encodeURIComponent(target.id)}/icon`, undefined, 'DELETE'), { onError })
  state.pending = false
  if (!ok) return
  close()
  emit('saved', `${target.displayName || target.id} 的图标已移除。`)
}
function close() {
  state.open = false
  state.chosen = null
}
defineExpose({ open })
</script>

<template>
  <FormDialog
    :open="state.open"
    id="icon"
    :title="`插件图标 · ${name}`"
    :subtitle="state.target?.package || state.target?.id || ''"
    close-label="关闭插件图标"
    submit-label="保存图标"
    :submit-disabled="!state.chosen"
    :pending="state.pending"
    :error="state.error"
    @submit="save"
    @close="close"
  >
    <div class="d-flex align-items-center justify-content-center gap-4 my-2">
      <figure class="m-0 text-center">
        <span class="avatar avatar-xl rounded">
          <img v-if="state.current" v-show="state.hasIcon" :src="state.current" alt="当前图标" @load="state.hasIcon = true" @error="state.hasIcon = false" />
          <span v-if="!state.hasIcon" class="small">无图标</span>
        </span>
        <figcaption class="text-secondary small mt-2">当前</figcaption>
      </figure>
      <span class="text-secondary" aria-hidden="true">→</span>
      <figure class="m-0 text-center">
        <span class="avatar avatar-xl rounded">
          <img v-if="state.preview" :src="state.preview" alt="新图标预览" />
          <span v-else class="small">未选择</span>
        </span>
        <figcaption class="text-secondary small mt-2">保存后</figcaption>
      </figure>
    </div>
    <p class="text-secondary small text-center text-break">{{ state.info }}</p>
    <div class="form-hint">
      支持 PNG、JPEG、WebP、GIF、SVG、BMP 等常见图片。PNG、JPEG、WebP 在 256 KB 以内原样保存；其他格式或更大的图片会先在浏览器里转成 PNG（最长边 512 像素）。建议用正方形、至少 128×128。插件市场卡片、文档中心和后台显示的都是这一张图。
    </div>
    <input ref="file" type="file" accept="image/*,.svg,.ico" hidden @change="picked" />
    <template #footer>
      <button type="button" class="btn btn-ghost-danger me-auto" :disabled="!state.hasIcon || state.pending" @click="remove">移除图标</button>
      <button type="button" class="btn" :disabled="state.pending" @click="pick">{{ state.chosen || state.hasIcon ? '换一张图片' : '选择图片' }}</button>
    </template>
  </FormDialog>
</template>
