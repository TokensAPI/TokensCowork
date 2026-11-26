<script setup lang="ts">
import { computed, reactive } from 'vue'
import FormDialog from '../FormDialog.vue'
import { ApiError, request } from '../../api'
import { notify, runAction } from '../../feedback'
import { confirmDiscard } from '../../confirm'
import type { MarketPlugin } from '../../plugins'

/**
 * A plugin's release notes ("更新说明"), one version at a time: pick the version (newest first), then
 * for Chinese and for English see the text taken from that version's package CHANGELOG (read-only)
 * and write the console's own, which the app shows instead; clearing it falls back to the package's
 * text. The market reads a version's package the first time it is asked for, so opening an older
 * version may take a moment. Saving keeps the dialog open for the next version; switching version
 * or closing with unsaved text asks first.
 */
export interface NoteText {
  zh: string | null
  en: string | null
}
export interface PluginNote {
  version: string
  publishedAt: string | null
  auto: NoteText
  admin: NoteText
  extractedAt: number | null
  updatedAt: number | null
}
interface NoteList {
  pluginId: string
  source: 'npm' | 'tokenscowork' | 'github'
  package: string
  versionsAvailable: boolean
  items: PluginNote[]
}
const MAX = 4000
const LANGUAGES = [['zh', '中文'], ['en', 'English']] as const
type Language = (typeof LANGUAGES)[number][0]

const state = reactive({
  open: false, plugin: null as MarketPlugin | null, list: null as NoteList | null, version: '', draft: { zh: '', en: '' } as Record<Language, string>,
  loading: false, reading: false, pending: false, error: '', serial: 0,
})
const current = computed(() => state.list?.items.find((item) => item.version === state.version) ?? null)
const baseline = (item: PluginNote | null) => ({ zh: item?.admin.zh ?? '', en: item?.admin.en ?? '' })
/** Whether the version on screen holds text not saved yet. */
const dirty = () => state.open && !!current.value && (['zh', 'en'] as const).some((lang) => state.draft[lang].trim() !== baseline(current.value)[lang])

const path = (version?: string) => `/api/v1/plugins/${encodeURIComponent(state.plugin!.id)}/notes${version ? '/' + encodeURIComponent(version) : ''}`
const showError = (message: string, cause: unknown) => {
  if (!(cause instanceof ApiError && cause.status === 401)) state.error = message
}
function replace(item: PluginNote) {
  if (!state.list) return
  state.list.items = state.list.items.map((entry) => (entry.version === item.version ? item : entry))
}
function show(version: string) {
  state.version = version
  state.draft = baseline(current.value)
  state.error = ''
  // A version not read from its package yet is read now; the text appears when it is.
  const item = current.value
  if (item && item.extractedAt === null && state.list?.source !== 'github') void read(version)
}
async function read(version: string) {
  const serial = state.serial
  state.reading = true
  try {
    const item = await request<PluginNote>(path(version))
    if (serial !== state.serial) return
    replace(item)
    // Text typed meanwhile is kept; only an untouched draft follows the stored text.
    if (state.version === version && !dirty()) state.draft = baseline(item)
  } catch (error) {
    if (serial === state.serial && state.version === version) showError(error instanceof Error ? error.message : String(error), error)
  } finally {
    if (serial === state.serial) state.reading = false
  }
}

/** Opens the dialog on one market plugin's newest version. */
async function open(plugin: MarketPlugin) {
  Object.assign(state, { open: true, plugin, list: null, version: '', draft: { zh: '', en: '' }, loading: true, reading: false, pending: false, error: '', serial: state.serial + 1 })
  const serial = state.serial
  try {
    const list = await request<NoteList>(path())
    if (serial !== state.serial) return
    state.list = list
    if (list.items[0]) show(list.items[0].version)
  } catch (error) {
    if (serial === state.serial) showError(error instanceof Error ? error.message : String(error), error)
  } finally {
    if (serial === state.serial) state.loading = false
  }
}
async function pick(event: Event) {
  const select = event.target as HTMLSelectElement
  const next = select.value
  if (next === state.version) return
  if (dirty() && !(await confirmDiscard())) {
    select.value = state.version
    return
  }
  show(next)
}
async function close() {
  if (state.pending) return
  if (dirty() && !(await confirmDiscard())) return
  state.open = false
  state.serial++
}
async function save() {
  const item = current.value
  if (!item || !dirty()) return
  const version = item.version
  state.pending = true
  state.error = ''
  let saved: PluginNote | undefined
  const ok = await runAction(async () => {
    saved = await request<PluginNote>(path(version), { zh: state.draft.zh.trim() || null, en: state.draft.en.trim() || null }, 'PUT')
  }, { onError: showError })
  state.pending = false
  if (!ok || !saved) return
  replace(saved)
  if (state.version === version) state.draft = baseline(saved)
  notify(`${state.plugin?.displayName ?? ''} v${version} 的更新说明已保存。`)
}

// ── What is shown ──────────────────────────────────────────────────────────
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '')
function status(item: PluginNote) {
  if (item.admin.zh || item.admin.en) return '后台已填写'
  if (item.auto.zh || item.auto.en) return '来自更新记录'
  if (item.extractedAt === null && state.list?.source !== 'github') return '未读取'
  return '无说明'
}
const optionText = (item: PluginNote, index: number) =>
  [`v${item.version}`, day(item.publishedAt), index === 0 ? '最新' : '', status(item)].filter(Boolean).join(' · ')
const sourceText = computed(() =>
  state.list?.source === 'github'
    ? 'GitHub 安装的插件没有安装包可读，只有后台填写的说明。'
    : `取自这一版安装包（${state.list?.source === 'tokenscowork' ? '自建 Registry' : 'npm'}）里的 CHANGELOG.md / CHANGELOG.en.md。`,
)
function autoEmpty(item: PluginNote) {
  if (state.list?.source === 'github') return '没有自动内容。'
  if (item.extractedAt === null) return state.reading ? '正在读取这一版的安装包…' : '暂时没能读取这一版的安装包，稍后重新打开会再试。'
  return '安装包里没有这一版的更新记录。'
}
/** What the app shows in this language once the draft is saved. */
function shown(lang: Language) {
  const item = current.value
  if (state.draft[lang].trim()) return ['后台填写', 'bg-blue-lt']
  if (item?.auto[lang]) return ['自动内容', 'bg-green-lt']
  return ['无说明', 'bg-secondary-lt']
}
function useAuto(lang: Language) {
  const text = current.value?.auto[lang]
  if (text) state.draft[lang] = text
}
defineExpose({ open, dirty })
</script>

<template>
  <FormDialog
    :open="state.open"
    id="notes"
    :title="`更新说明 · ${state.plugin?.displayName ?? ''}`"
    :subtitle="state.plugin?.package ?? ''"
    close-label="关闭更新说明"
    submit-label="保存这一版"
    size="lg"
    scrollable
    :submit-disabled="state.loading || !current || !dirty()"
    :pending="state.pending"
    :error="state.error"
    @submit="save"
    @close="close"
  >
    <div v-if="state.loading" class="empty py-4" role="status"><p class="empty-title text-secondary">正在读取版本…</p></div>
    <template v-else-if="state.list">
      <div v-if="!state.list.versionsAvailable" class="alert alert-warning">暂时读不到 Registry 的版本列表，下面只列出当前版本和已保存过说明的版本。</div>
      <div v-if="!state.list.items.length" class="empty py-4">
        <p class="empty-title">还没有可以填写的版本</p>
        <p class="empty-subtitle text-secondary">插件发布稳定版本后，这里会列出它的各个版本。</p>
      </div>
      <template v-else>
        <div class="mb-3">
          <label class="form-label" for="notes-version">版本</label>
          <select id="notes-version" class="form-select" :value="state.version" :disabled="state.pending" @change="pick">
            <option v-for="(item, index) in state.list.items" :key="item.version" :value="item.version">{{ optionText(item, index) }}</option>
          </select>
          <div class="form-hint">应用里显示后台填写的内容；没有填写时显示从安装包更新记录取出的内容。中文、英文分别判断。</div>
        </div>
        <div v-if="current" class="row g-3" :aria-busy="state.reading || undefined">
          <section v-for="[lang, label] in LANGUAGES" :key="lang" class="col-12 col-md-6 notes-pane" :aria-labelledby="`notes-${lang}-title`">
            <div class="d-flex align-items-center gap-2 mb-2">
              <h3 :id="`notes-${lang}-title`" class="h4 m-0">{{ label }}</h3>
              <span :class="['badge', shown(lang)[1]]">应用显示：{{ shown(lang)[0] }}</span>
            </div>
            <div class="form-label">自动内容 <span class="text-secondary fw-normal">（只读）</span></div>
            <div :class="['notes-auto', !current.auto[lang] && 'text-secondary']">{{ current.auto[lang] || autoEmpty(current) }}</div>
            <div class="form-hint mb-3">{{ sourceText }}</div>
            <div class="d-flex align-items-center gap-2">
              <label class="form-label me-auto mb-1" :for="`notes-${lang}`">后台填写</label>
              <button v-if="current.auto[lang] && !state.draft[lang].trim()" type="button" class="btn btn-sm btn-ghost-secondary mb-1" @click="useAuto(lang)">以自动内容为底稿</button>
              <button v-if="state.draft[lang]" type="button" class="btn btn-sm btn-ghost-secondary mb-1" @click="state.draft[lang] = ''">清空</button>
            </div>
            <textarea
              :id="`notes-${lang}`"
              v-model="state.draft[lang]"
              class="form-control notes-input"
              rows="7"
              :maxlength="MAX"
              :placeholder="lang === 'zh' ? '留空则显示上面的自动内容' : 'Leave empty to show the text above'"
            ></textarea>
            <div class="form-hint d-flex">
              <span class="me-auto">纯文本，可用 - 列表、**加粗**、`代码`</span>
              <span>{{ state.draft[lang].length }} / {{ MAX }}</span>
            </div>
          </section>
        </div>
      </template>
    </template>
  </FormDialog>
</template>
