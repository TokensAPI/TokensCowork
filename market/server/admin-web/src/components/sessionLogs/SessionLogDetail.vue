<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import FoldText from './FoldText.vue'
import LogTurn from './LogTurn.vue'
import KeyLines from './KeyLines.vue'
import ModalDialog from '../ModalDialog.vue'
import { groupConversation, rawDocument, type TurnGroup } from './replay'
import { request } from '../../api'
import { runAction } from '../../feedback'
import { formatTime } from '../../shell'
import { platformName } from '../../lib/session-log-format.js'
import {
  accountOf, copyText, downloadSessionLog, lookupNames, organizationText, sessionPath,
  type SessionEvent, type SessionKey, type SessionList, type SessionPage, type SessionSummary,
} from '../../sessionLogs'

/**
 * One session's detail: an overview, then two tabs --
 * 「对话」 (each turn: what the user typed, a fold with everything in between, the final answer) and
 * 「原始 JSON」 (the whole session in the upload format, shown a piece at a time, with downloads and
 * copy). Every byte is user content and is only ever placed as text; final answers go through the
 * docs center's Markdown renderer, which builds elements and text nodes only.
 *
 * The page opens a session with open() (only the latest call counts) and the parent / child buttons
 * go through `openSession`, so each opened session has its own address and 「返回」 comes back.
 */
const props = defineProps<{ openSession: (id: string, formatVersion: number) => Promise<void> }>()
const emit = defineEmits<{ back: [] }>()

const PAGE = 1000
const RAW_CHUNK = 256 * 1024
const DIALOG_LIMIT = 2 * 1024 * 1024
const time = (value?: number | null) => (value ? formatTime(value) : '—')
const number = (value?: number) => Number(value || 0).toLocaleString('zh-CN')
const size = (length: number) => (length >= 1024 * 1024 ? `${(length / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(length / 1024))} KB`)

const current = shallowRef<(SessionSummary & { keys: SessionKey[] }) | null>(null)
const header = shallowRef<unknown>(null)
const events = shallowRef<SessionEvent[]>([])
const progress = ref('')
const showInternal = ref(false)
const tab = ref<'conversation' | 'raw'>('conversation')
// Which turns' process folds are open ('opening' for before the first turn); kept across re-renders
// and cleared when another session opens.
const openTurns = reactive(new Set<string>())
const pending = reactive({ parent: false, child: false, json: false, jsonl: false })

const grouped = computed(() => groupConversation(events.value))
const groups = computed<TurnGroup[]>(() => [grouped.value.opening, ...grouped.value.turns])
const turnKey = (group: TurnGroup) => String(group.turn ?? 'opening')
const shownGroups = computed(() =>
  groups.value.filter((group) => group.turn !== null || group.items.some((item) => item.kind === 'user' || showInternal.value || item.kind !== 'internal')),
)
const loaded = computed(() => {
  if (progress.value) return progress.value
  if (!current.value) return ''
  const hidden = groups.value.reduce((sum, group) => sum + group.items.filter((item) => item.kind === 'internal').length, 0)
  return `${number(events.value.length)} 条事件 · ${grouped.value.turns.length} 轮${showInternal.value ? '' : ` · 已隐藏 ${number(hidden)} 条内部事件`}${
    current.value.missingEvents ? ` · 缺 ${current.value.missingEvents} 条` : ''}`
})
function setAllFolds(open: boolean) {
  openTurns.clear()
  if (open) for (const group of groups.value) if (group.items.some((item) => item.kind !== 'user')) openTurns.add(turnKey(group))
}
function toggleTurn(group: TurnGroup, open: boolean) {
  if (open) openTurns.add(turnKey(group))
  else openTurns.delete(turnKey(group))
}

// ── Overview ───────────────────────────────────────────────────────────────
const SETTINGS: Record<string, string> = { 'permission/preset': '权限预设', 'sandbox/mode': '沙箱', 'approval/policy': '审批策略' }
const account = computed(() => {
  const id = current.value?.accountId
  if (!id) return { account: '—', organization: '—' }
  const user = accountOf(id)
  if (!user) return { account: `${id}（客户端上报，未核验）`, organization: '—' }
  const org = organizationText(user)
  return { account: `${id} · ${user.name}（客户端上报，未核验；名称按此 ID 查得）`, organization: org ? `${org}（按上报账号查到的当前归属，未核验）` : '—' }
})
const clientText = (client: SessionSummary['client']) => [client.product, client.version, platformName(client.platform)].filter(Boolean).join(' ') || '—'
const chips = computed(() => {
  const overview = grouped.value.overview
  const list = Object.entries(SETTINGS).filter(([type]) => overview.settings[type]).map(([type, label]) => `${label} ${overview.settings[type]}`)
  const d = overview.descriptor
  if (d) list.push(`子代理 ${[d.label, d.mode, [d.agentProvider, d.agentModel].filter(Boolean).join(' / ')].filter(Boolean).join(' · ')}`)
  return list
})
const tokens = computed(() => {
  const t = current.value?.tokens
  return t?.total ? `${number(t.total)}（输入 ${number(t.input)} · 输出 ${number(t.output)}）` : '—'
})

// ── Raw JSON ───────────────────────────────────────────────────────────────
// Built once per opened session and shown a piece at a time, so tens of megabytes never land in
// the page at once.
const rawBox = ref<HTMLPreElement>()
const sentinel = ref<HTMLDivElement>()
let raw: string | null = null
const rawShown = ref(0)
const rawLength = ref(0)
let observer: IntersectionObserver | null = null
function rawText() {
  raw ??= rawDocument(header.value, events.value, current.value!.formatVersion, current.value!.id)
  rawLength.value = raw.length
  return raw
}
const rawSize = computed(() => {
  if (!rawShown.value) return ''
  const done = rawShown.value >= rawLength.value
  return `${number(events.value.length)} 条事件 · ${size(rawLength.value)}${done ? '' : ` · 已显示 ${size(rawShown.value)}，向下滚动继续`}`
})
function showMoreRaw() {
  const text = rawText()
  if (rawShown.value >= text.length || !rawBox.value) return
  let end = Math.min(text.length, rawShown.value + RAW_CHUNK)
  // End a piece at a line break; a single huge line (a long string value) is cut where it is.
  if (end < text.length) {
    const cut = text.indexOf('\n', end)
    if (cut !== -1 && cut - end < RAW_CHUNK) end = cut + 1
  }
  rawBox.value.append(document.createTextNode(text.slice(rawShown.value, end)))
  rawShown.value = end
}
async function renderRaw() {
  if (rawShown.value) return
  await nextTick()
  rawBox.value?.replaceChildren()
  showMoreRaw()
  observer?.disconnect()
  if ('IntersectionObserver' in window && sentinel.value) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && tab.value === 'raw') showMoreRaw()
    }, { rootMargin: '600px' })
    observer.observe(sentinel.value)
  }
}
watch(tab, (name) => name === 'raw' && renderRaw())

async function download(format: 'json' | 'jsonl') {
  if (!current.value || pending[format]) return
  pending[format] = true
  await runAction(() => downloadSessionLog(current.value!.id, current.value!.formatVersion, format), { success: `${format.toUpperCase()} 已下载，已写入操作记录。` })
  pending[format] = false
}
const copyAll = () => runAction(() => copyText(rawText(), '浏览器不允许复制，请改用下载。'), { success: '整个会话的 JSON 已复制。' })

// ── One event's JSON ───────────────────────────────────────────────────────
const json = reactive({ open: false, text: '', full: '' })
function showJson(value: unknown) {
  const full = JSON.stringify(value, null, 2) ?? ''
  json.full = full
  json.text = full.length > DIALOG_LIMIT ? full.slice(0, DIALOG_LIMIT) + `\n…（共 ${size(full.length)}，只显示前 ${size(DIALOG_LIMIT)}；完整内容请用「复制」或下载）` : full
  json.open = true
}
const copyJson = () => runAction(() => copyText(json.full, '浏览器不允许复制，请改用下载。'), { success: '已复制。' })

// ── Loading ────────────────────────────────────────────────────────────────
// Every page of the session, in order; only the first one is recorded as a read.
async function loadAll(id: string, formatVersion: number) {
  let after: number | null = -1
  const all: SessionEvent[] = []
  let first: SessionPage | null = null
  do {
    const result: SessionPage = await request<SessionPage>(`${sessionPath(id, formatVersion)}?${new URLSearchParams({ after: String(after), limit: String(PAGE) })}`)
    first ??= result
    all.push(...result.events)
    after = result.next
    progress.value = `读取中 ${number(all.length)} / ${number(result.session.eventCount)} 条事件…`
  } while (after !== null)
  return { ...first!, events: all }
}
/** Opens a session; resolves false when a later call won meanwhile (its answer is dropped). */
async function open(id: string, formatVersion: number, isCurrent: () => boolean = () => true) {
  let result
  try {
    result = await loadAll(id, formatVersion)
  } finally {
    if (isCurrent()) progress.value = ''
  }
  if (!isCurrent()) return false
  observer?.disconnect()
  current.value = { ...result.session, keys: result.keys }
  header.value = result.header ?? null
  events.value = result.events
  openTurns.clear()
  raw = null
  rawShown.value = 0
  rawLength.value = 0
  rawBox.value?.replaceChildren()
  tab.value = 'conversation'
  if (current.value.accountId) lookupNames([current.value.accountId])
  return true
}
/** A parent or child session opens like any other: through its own address. */
async function openBySession(sessionId: string, missing: string, which: 'parent' | 'child') {
  if (pending[which]) return
  pending[which] = true
  await runAction(async () => {
    const found = await request<SessionList>('/api/v1/session-logs?' + new URLSearchParams({ session: sessionId }))
    const first = found.items[0]
    if (!first) throw new Error(missing)
    await props.openSession(first.id, first.formatVersion)
  })
  pending[which] = false
}
function close() {
  observer?.disconnect()
  current.value = null
  header.value = null
  events.value = []
  raw = null
  rawShown.value = 0
  json.open = false
}
onBeforeUnmount(() => observer?.disconnect())

defineExpose({
  open,
  close,
  isOpen: () => current.value !== null,
  shows: (id: string, formatVersion: number) => current.value?.id === id && current.value?.formatVersion === formatVersion,
})
</script>

<template>
  <div>
    <div class="mb-2">
      <button type="button" class="btn btn-ghost-primary btn-sm px-2" title="返回列表（Esc），筛选和位置保持不变" @click="emit('back')">← 会话日志</button>
    </div>
    <div v-if="current" class="card">
      <div class="card-header flex-wrap gap-2">
        <div class="min-w-0">
          <h3 class="card-title">{{ current.title || '未命名会话' }}</h3>
          <p class="card-subtitle font-monospace text-break">{{ [current.id, `格式 v${current.formatVersion}`, current.parentSession ? '子代理会话' : ''].filter(Boolean).join(' · ') }}</p>
        </div>
        <div class="card-actions btn-list">
          <button
            v-if="current.parentSession"
            type="button"
            :class="['btn', pending.parent && 'btn-loading']"
            :disabled="pending.parent"
            @click="openBySession(current.parentSession, '父会话的日志不在这里（可能未上传或已删除）。', 'parent')"
          >
            打开父会话
          </button>
        </div>
      </div>
      <div class="card-body border-bottom log-overview">
        <dl class="log-facts">
          <div><dt class="text-secondary">上报账号</dt><dd><span>{{ account.account }}</span></dd></div>
          <div><dt class="text-secondary">组织</dt><dd><span>{{ account.organization }}</span></dd></div>
          <div>
            <dt class="text-secondary">{{ current.keys.length > 1 ? `Key（${current.keys.length} 把）` : 'Key' }}</dt>
            <dd>
              <div>
                <span v-if="!current.keys.length" class="text-secondary">未带 Key（匿名）</span>
                <div v-for="item in current.keys" :key="item.fingerprint" class="session-log-key">
                  <KeyLines :item="item" />
                  <div v-if="current.keys.length > 1" class="text-secondary">首次 {{ time(item.firstUsedAt) }} · 最近 {{ time(item.lastUsedAt) }}</div>
                </div>
              </div>
            </dd>
          </div>
          <div><dt class="text-secondary">客户端</dt><dd>{{ clientText(current.client) }}</dd></div>
          <div v-if="current.cwd"><dt class="text-secondary">目录</dt><dd class="log-code">{{ current.cwd }}</dd></div>
          <div><dt class="text-secondary">创建</dt><dd>{{ time(current.createdAt) }}</dd></div>
          <div><dt class="text-secondary">最近上传</dt><dd>{{ time(current.lastReceivedAt) }}</dd></div>
          <div><dt class="text-secondary">模型</dt><dd>{{ current.models.join('、') || '—' }}</dd></div>
          <div><dt class="text-secondary">累计 token</dt><dd>{{ tokens }}</dd></div>
        </dl>
        <div v-if="chips.length" class="badges-list">
          <span v-for="chip in chips" :key="chip" class="badge bg-secondary-lt">{{ chip }}</span>
        </div>
        <FoldText
          v-for="(text, index) in grouped.overview.systemPrompts"
          :key="index"
          :text="text"
          :lines="0"
          code
          :label="grouped.overview.systemPrompts.length > 1 ? `系统提示词 ${index + 1}/${grouped.overview.systemPrompts.length}` : '系统提示词'"
        />
      </div>
      <div class="card-header flex-wrap gap-2">
        <ul class="nav nav-tabs card-header-tabs" role="tablist" aria-label="会话视图">
          <li class="nav-item">
            <button :class="['nav-link', tab === 'conversation' && 'active']" type="button" role="tab" aria-controls="session-log-conversation" :aria-selected="tab === 'conversation'" @click="tab = 'conversation'">对话</button>
          </li>
          <li class="nav-item">
            <button :class="['nav-link', tab === 'raw' && 'active']" type="button" role="tab" aria-controls="session-log-raw" :aria-selected="tab === 'raw'" @click="tab = 'raw'">原始 JSON</button>
          </li>
        </ul>
        <div class="card-actions d-flex flex-wrap align-items-center gap-2">
          <span class="text-secondary small">{{ loaded }}</span>
          <span v-if="tab === 'conversation'" class="btn-list">
            <button type="button" class="btn btn-sm" @click="setAllFolds(true)">全部展开</button>
            <button type="button" class="btn btn-sm" @click="setAllFolds(false)">全部收起</button>
          </span>
          <label v-if="tab === 'conversation'" class="form-check form-switch m-0">
            <input v-model="showInternal" class="form-check-input" type="checkbox" /><span class="form-check-label">显示内部事件</span>
          </label>
        </div>
      </div>
      <div class="card-body">
        <div v-show="tab === 'conversation'" id="session-log-conversation" role="tabpanel">
          <div class="log-turns">
            <LogTurn
              v-for="group in groups"
              :key="turnKey(group)"
              :group="group"
              :show-internal="showInternal"
              :open="openTurns.has(turnKey(group))"
              :delegated="!!current.parentSession"
              :child-busy="pending.child"
              @toggle="toggleTurn(group, $event)"
              @json="showJson"
              @child="openBySession($event, '子会话的日志不在这里（可能未上传或已删除）。', 'child')"
            />
          </div>
          <div v-if="!shownGroups.length" class="empty"><p class="empty-title">这个会话没有可显示的事件</p></div>
        </div>
        <div v-show="tab === 'raw'" id="session-log-raw" role="tabpanel">
          <div class="d-flex flex-wrap align-items-center gap-2">
            <span class="text-secondary">{{ rawSize }}</span>
            <div class="btn-list ms-auto">
              <button type="button" :class="['btn', pending.json && 'btn-loading']" :disabled="pending.json" @click="download('json')">下载 JSON</button>
              <button type="button" :class="['btn', pending.jsonl && 'btn-loading']" :disabled="pending.jsonl" @click="download('jsonl')">下载 JSONL</button>
              <button type="button" class="btn" @click="copyAll">复制</button>
            </div>
          </div>
          <pre ref="rawBox" class="log-raw"></pre>
          <div ref="sentinel" class="log-raw-sentinel" aria-hidden="true"></div>
          <button v-if="rawShown && rawShown < rawLength" type="button" class="btn" @click="showMoreRaw">显示更多</button>
        </div>
      </div>
    </div>
    <div v-else-if="progress" class="card"><div class="card-body text-secondary">{{ progress }}</div></div>

    <ModalDialog :open="json.open" labelledby="session-log-json-title" size="xl" scrollable @close="json.open = false">
      <div class="modal-content">
        <div class="modal-header">
          <h2 id="session-log-json-title" class="modal-title">原始 JSON</h2>
          <button class="btn-close" type="button" aria-label="关闭原始 JSON" @click="json.open = false"></button>
        </div>
        <div class="modal-body"><pre class="log-raw m-0">{{ json.text }}</pre></div>
        <div class="modal-footer"><button type="button" class="btn" @click="copyJson">复制</button></div>
      </div>
    </ModalDialog>
  </div>
</template>
