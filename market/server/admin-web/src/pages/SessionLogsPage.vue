<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { request } from '../api'
import { notify, runAction } from '../feedback'
import { confirmAction } from '../confirm'
import { formatTime, shell, useRefresh } from '../shell'
import { loadOrganizations, type Organization } from '../directory'
import { viewById } from '../views'
import PageHeader from '../components/PageHeader.vue'
import DataPager from '../components/DataPager.vue'
import RowActions from '../components/RowActions.vue'
import FormDialog from '../components/FormDialog.vue'
import SessionLogDetail from '../components/sessionLogs/SessionLogDetail.vue'
import {
  TIME_PRESETS, classifySearch, sizeText, tokenText, relativeTime, shortKey, platformName, sessionRoute, parseSessionRoute,
} from '../../../admin/assets/market-session-log-format.js'
import {
  accountOf, copyText, downloadSessionLog, lookupNames, organizationText, sessionPath, titleOf,
  type SessionList, type SessionSummary,
} from '../sessionLogs'

/**
 * The session-log page, as at /admin/#session-logs (market-session-logs.js, the T0100 layout): the
 * index of sessions the desktop plugin uploaded, paged on the server. One search box (account,
 * session id or Key, told apart by classifySearch), the organization, model and time pickers,
 * 「更多筛选」 for the rest, and the applied filters as removable tags; the totals of what the
 * filters match; ticked-row and date-range deletion, each confirmed first; a note and tags per
 * session; the retention setting. Platform administrators only.
 *
 * Nothing here locks the page (T0101): reads disable nothing and only the latest answer is shown,
 * so a late one never replaces a newer one; while the list reloads only the table dims. A change
 * locks just the button or dialog it came from. An opened session has its own address
 * (#session-logs/<session>/<format version>); the back button, 「← 会话日志」 and Esc return to the
 * list as it was left -- filters, page and scroll.
 */
const view = viewById('session-logs')!
const route = useRoute()
const router = useRouter()
const DAY = 24 * 60 * 60 * 1000
const time = (value?: number | null) => (value ? formatTime(value) : '—')
const nameOf = (item: SessionSummary) => `${item.id}:${item.formatVersion}`

// ── Filters ────────────────────────────────────────────────────────────────
const form = reactive({ search: '', organization: '', model: '', time: '', from: '', to: '', version: '', tag: '' })
const moreOpen = ref(false)
let filters: Record<string, string> = {}
const filtering = () => Object.values(filters).some(Boolean)
const organizations = ref<Organization[]>([])
const models = reactive(new Set<string>())
const modelList = computed(() => [...models].sort())

// The search box fills exactly one of account / session / key; a preset time reaches back from now,
// a custom one is the two dates under 「更多筛选」 (end date inclusive).
function readFilters() {
  const day = (value: string, offset = 0) => (value ? String(new Date(value + 'T00:00:00').getTime() + offset) : '')
  const search = classifySearch(form.search)
  const preset = (TIME_PRESETS as Record<string, number>)[form.time]
  return {
    account: search?.field === 'account' ? search.value : '', session: search?.field === 'session' ? search.value : '',
    key: search?.field === 'key' ? search.value : '', organization: form.organization,
    model: form.model.trim(), clientVersion: form.version.trim(), tag: form.tag.trim(),
    from: preset ? String(Date.now() - preset) : form.time === 'custom' ? day(form.from) : '',
    to: form.time === 'custom' ? day(form.to, DAY) : '',
  }
}
function apply() {
  filters = readFilters()
  page.value = 1
  void read(loadList)
}
function onTime() {
  if (form.time === 'custom') {
    moreOpen.value = true
    return
  }
  form.from = ''
  form.to = ''
  apply()
}
// Picking a date is a custom range, applied once either end is set.
function onDate() {
  form.time = 'custom'
  apply()
}
function onSearch() {
  if (!form.search) apply()
}
function reset() {
  Object.assign(form, { search: '', organization: '', model: '', time: '', from: '', to: '', version: '', tag: '' })
  filters = {}
  page.value = 1
  void read(loadList)
}
const TIME_NAMES: Record<string, string> = { '24h': '近 24 小时', '7d': '近 7 天', '30d': '近 30 天' }
interface Chip {
  label: string
  clear: () => void
}
const chips = shallowRef<Chip[]>([])
// The applied filters as tags; ✕ clears that one control and reloads.
function renderChips() {
  const searchLabel: Record<string, string> = { account: '账号', session: '会话', key: 'Key' }
  const day = (value: string | number) => new Date(Number(value)).toLocaleDateString('zh-CN')
  const list: Chip[] = []
  const search = classifySearch(form.search)
  if (search && filters[search.field]) list.push({ label: `${searchLabel[search.field]}：${search.value}`, clear: () => (form.search = '') })
  if (filters.organization) {
    const org = organizations.value.find((item) => String(item.id) === filters.organization)
    list.push({ label: `组织：${org ? `${org.name} (#${org.id})` : filters.organization}`, clear: () => (form.organization = '') })
  }
  if (filters.model) list.push({ label: `模型：${filters.model}`, clear: () => (form.model = '') })
  if (filters.from || filters.to) {
    const text = form.time === 'custom'
      ? `${filters.from ? day(filters.from) : '最早'} 至 ${filters.to ? day(Number(filters.to) - DAY) : '现在'}`
      : TIME_NAMES[form.time] ?? ''
    list.push({ label: `时间：${text}`, clear: () => Object.assign(form, { time: '', from: '', to: '' }) })
  }
  if (filters.clientVersion) list.push({ label: `版本：${filters.clientVersion}`, clear: () => (form.version = '') })
  if (filters.tag) list.push({ label: `标签：${filters.tag}`, clear: () => (form.tag = '') })
  chips.value = list
}
function dropChip(chip: Chip) {
  chip.clear()
  apply()
}

// ── List ───────────────────────────────────────────────────────────────────
const page = ref(1)
const pageSize = ref(50)
const total = ref(0)
const storedBytes = ref(0)
const keyDisplayReady = ref(true)
const items = shallowRef<SessionSummary[]>([])
const listLoaded = ref(false)
const listLoading = ref(false)
let listTurn = 0
const selected = reactive(new Map<string, SessionSummary>())

/** A read reports its error like any operation but disables nothing. */
const read = (fn: () => Promise<unknown>, success?: string) => runAction(fn, { success })

async function loadList() {
  const turn = ++listTurn
  const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), page: String(page.value), pageSize: String(pageSize.value) })
  listLoading.value = true
  let result: SessionList
  try {
    result = await request<SessionList>('/api/v1/session-logs?' + query)
  } finally {
    if (turn === listTurn) listLoading.value = false
  }
  // A newer filter or page was asked for meanwhile; its answer is the one to show.
  if (turn !== listTurn) return
  listLoaded.value = true
  total.value = result.total
  storedBytes.value = result.storedBytes
  // The server answers a page past the end with the last page; follow it.
  page.value = result.page
  pageSize.value = result.pageSize
  items.value = result.items
  keyDisplayReady.value = result.keyDisplayReady
  selected.clear()
  for (const item of result.items) for (const model of item.models) models.add(model)
  lookupNames(result.items.map((item) => item.accountId))
  shell.lastRefresh = Date.now()
  renderChips()
}
const summary = computed(() => `${filtering() ? '符合筛选的' : '共'} ${total.value} 个会话 · ${sizeText(storedBytes.value)}`)
const emptyTitle = computed(() => (filtering() ? '没有符合条件的会话' : '暂无会话日志'))
function goTo(target: number) {
  page.value = target
  void read(loadList)
}
function setPageSize(size: number) {
  pageSize.value = size
  page.value = 1
  void read(loadList)
}

// ── Rows ───────────────────────────────────────────────────────────────────
const clientMeta = (item: SessionSummary) =>
  ([item.client.version, platformName(item.client.platform)].filter(Boolean).join(' · ') || '—') + (item.parentSession ? ' · 子代理会话' : '')
const allChecked = computed(() => items.value.length > 0 && selected.size === items.value.length)
const someChecked = computed(() => selected.size > 0 && selected.size < items.value.length)
function check(item: SessionSummary, on: boolean) {
  if (on) selected.set(nameOf(item), item)
  else selected.delete(nameOf(item))
}
function checkAll(on: boolean) {
  for (const item of items.value) check(item, on)
}
function rowClick(event: MouseEvent, item: SessionSummary) {
  const target = event.target as HTMLElement
  if (target.closest('input, button, a, label, .dropdown-menu') || getSelection()?.toString()) return
  showSession(item)
}
const rowBusy = reactive(new Set<string>())
async function withLock(key: string, fn: () => Promise<unknown>) {
  if (rowBusy.has(key)) return
  rowBusy.add(key)
  try {
    await fn()
  } finally {
    rowBusy.delete(key)
  }
}
const rowMenu = (item: SessionSummary) => [
  { label: '查看', run: () => showSession(item) },
  { label: '下载 JSON', run: () => void withLock(nameOf(item), () => runAction(() => downloadSessionLog(item.id, item.formatVersion, 'json'), { success: 'JSON 已下载，已写入操作记录。' })) },
  { label: '编辑备注与标签', run: () => editNote(item) },
  'divider' as const,
  { label: '删除', danger: true, run: () => void removeOne(item) },
]
const copyKey = (key: string) => read(() => copyText(key, '浏览器不允许复制，请打开会话详情复制。'), 'Key 已复制。')

// ── Deletion ───────────────────────────────────────────────────────────────
// Every deletion asks first: what goes, how many, and that it cannot be undone.
const confirmDelete = (text: string, sessions: SessionSummary[] = []) =>
  confirmAction({ title: '删除会话日志？', text, ok: '确认删除', items: sessions.map((item) => `${titleOf(item)} · ${item.id}`), note: '删除后原文与索引一起移除，不可恢复。' })
async function removeOne(item: SessionSummary) {
  if (!(await confirmDelete(`删除这个会话的全部日志（${item.eventCount} 条事件）？`, [item]))) return
  await withLock(nameOf(item), () =>
    runAction(async () => {
      await request(sessionPath(item.id, item.formatVersion), undefined, 'DELETE')
      await loadList()
    }, { success: '会话日志已删除。' }))
}
async function removeSelected() {
  const sessions = [...selected.values()]
  if (!sessions.length) return
  if (!(await confirmDelete(`删除勾选的 ${sessions.length} 个会话的全部日志？`, sessions))) return
  await withLock('bulk', () =>
    runAction(async () => {
      const result = await request<{ count: number; missing?: number }>('/api/v1/session-logs', { sessions: sessions.map(({ id, formatVersion }) => ({ id, formatVersion })) }, 'DELETE')
      await loadList()
      notify(`已删除 ${result.count} 个会话${result.missing ? `（${result.missing} 个已不存在）` : ''}。`)
    }))
}
// A date range deletes every account's sessions in it, so it needs both dates of a custom range and
// is refused while any other filter is applied: what the list shows and what would be deleted must
// be the same set.
async function removeRange() {
  const { from, to, ...others } = filters
  if (!from || !to || form.time !== 'custom') return notify('请先在「时间」选「自定义」，在「更多筛选」填好起止日期并应用筛选。', 'error')
  if (Object.values(others).some(Boolean)) return notify('按日期删除会删掉该时段内所有账号的会话：请先清空其他筛选条件，或勾选后用「删除所选」。', 'error')
  const span = `${new Date(Number(from)).toLocaleDateString('zh-CN')} 至 ${new Date(Number(to) - DAY).toLocaleDateString('zh-CN')}`
  if (!(await confirmDelete(`删除创建于 ${span} 的全部 ${total.value} 个会话日志？`, total.value <= items.value.length ? items.value : []))) return
  await withLock('range', () =>
    runAction(async () => {
      const result = await request<{ count: number }>('/api/v1/session-logs', { from: Number(from), to: Number(to) }, 'DELETE')
      await loadList()
      notify(`已按日期删除 ${result.count} 个会话。`)
    }))
}

// ── Note and tags ──────────────────────────────────────────────────────────
const note = reactive({ open: false, item: null as SessionSummary | null, text: '', tags: '', pending: false, error: '' })
function editNote(item: SessionSummary) {
  Object.assign(note, { open: true, item, text: item.note ?? '', tags: item.tags.join(', '), pending: false, error: '' })
}
async function saveNote() {
  const item = note.item
  if (!item) return
  const tags = note.tags.split(/[,，\n]/u).map((tag) => tag.trim()).filter(Boolean)
  note.pending = true
  note.error = ''
  const ok = await runAction(async () => {
    await request(sessionPath(item.id, item.formatVersion), { note: note.text, tags }, 'PATCH')
    note.open = false
    await loadList()
  }, { success: '备注已保存。', onError: (message) => (note.error = message) })
  note.pending = false
  if (ok) note.item = null
}

// ── Retention setting ──────────────────────────────────────────────────────
const retentionDays = ref<number | null>(null)
const retentionKnown = ref(false)
const settings = reactive({ open: false, value: '' as string | number, pending: false, error: '' })
const settingsLabel = computed(() => (retentionKnown.value ? `设置 · 保留天数：${retentionDays.value ? `${retentionDays.value} 天` : '永久'}` : '设置'))
function openSettings() {
  Object.assign(settings, { open: true, value: retentionDays.value === null ? '' : String(retentionDays.value), pending: false, error: '' })
}
async function saveSettings() {
  const value = String(settings.value ?? '').trim()
  settings.pending = true
  settings.error = ''
  await runAction(async () => {
    const saved = await request<{ retentionDays?: number | null }>('/api/v1/session-logs/settings', { retentionDays: value ? Number(value) : null })
    retentionDays.value = saved.retentionDays ?? null
    retentionKnown.value = true
    settings.open = false
  }, { success: value ? `保留期已设为 ${value} 天。` : '已改为永久保留。', onError: (message) => (settings.error = message) })
  settings.pending = false
}

// ── Detail ─────────────────────────────────────────────────────────────────
const detail = ref<InstanceType<typeof SessionLogDetail>>()
const detailShown = ref(false)
const table = ref<HTMLDivElement>()
let detailTurn = 0
// Where the list was scrolled when a session was opened from it.
let returnTo: { y: number; x: number } | null = null

const showSession = (item: SessionSummary) => void read(() => openSession(item.id, item.formatVersion, { push: true }))
/**
 * Opens a session: loaded first (only the latest asked for counts), then shown, and when opened
 * from the page its own history entry is added, so the back button returns. The entry counts the
 * sessions opened in a row (a parent, then a child), so 「← 会话日志」 goes back past all of them.
 */
async function openSession(id: string, formatVersion: number, { push }: { push: boolean }) {
  const turn = ++detailTurn
  const fromList = !detailShown.value
  const scroll = { y: window.scrollY, x: table.value?.scrollLeft ?? 0 }
  if (!(await detail.value!.open(id, formatVersion, () => turn === detailTurn))) return
  if (fromList) returnTo = scroll
  shell.lastRefresh = Date.now()
  const path = '/' + sessionRoute(id, formatVersion)
  detailShown.value = true
  if (push && route.path !== path) {
    const depth = ((history.state as { sessionLogDepth?: number } | null)?.sessionLogDepth ?? 0) + 1
    await router.push({ path, state: { sessionLogDepth: depth } })
  }
  await nextTick()
  window.scrollTo(0, 0)
}
// The list exactly as it was left; it is not asked for again.
async function back() {
  detailTurn++
  detail.value?.close()
  detailShown.value = false
  if (returnTo) {
    const target = returnTo
    await nextTick()
    window.scrollTo(0, target.y)
    if (table.value) table.value.scrollLeft = target.x
  }
}
// 「← 会话日志」 and Esc: through history when the sessions were opened here, so the back button stays
// in step; a session opened from a link has no list behind it, so the list is loaded.
function leaveDetail() {
  const depth = (history.state as { sessionLogDepth?: number } | null)?.sessionLogDepth ?? 0
  if (depth > 0) return router.go(-depth)
  void router.replace('/session-logs')
}
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || !detailShown.value) return
  const target = event.target as HTMLElement | null
  if (document.querySelector('dialog[open], .dropdown-menu.show') || target?.closest?.('input, textarea, select, [contenteditable="true"]')) return
  leaveDetail()
}

// The address decides: a session's address opens it (a link works on its own); a malformed one
// falls back to the list; coming back from a session shows the list as it was left.
async function follow() {
  const target = parseSessionRoute('#' + route.path.slice(1))
  if (target) {
    if (!detail.value?.shows(target.id, target.formatVersion))
      await read(async () => {
        try {
          await openSession(target.id, target.formatVersion, { push: false })
        } catch (error) {
          await router.replace('/session-logs')
          throw error
        }
      })
    return
  }
  if (route.path !== '/session-logs') return router.replace('/session-logs')
  if (detailShown.value) await back()
  if (!listLoaded.value) await read(refresh)
}
watch(() => route.path, () => route.meta.view === 'session-logs' && follow())

// The organizations, the retention setting and the list, as the page is opened.
async function refresh() {
  const [orgs, saved] = await Promise.all([loadOrganizations(), request<{ retentionDays?: number | null }>('/api/v1/session-logs/settings')])
  organizations.value = orgs.items
  if (form.organization && !orgs.items.some((org) => String(org.id) === form.organization)) form.organization = ''
  retentionDays.value = saved.retentionDays ?? null
  retentionKnown.value = true
  await loadList()
}
useRefresh(refresh)
onMounted(() => {
  document.addEventListener('keydown', onKey)
  void follow()
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))

const accountTitle = (id?: string | null) => (accountOf(id) ? '客户端上报的账号 ID，未核验；名称按此 ID 查得' : undefined)
</script>

<template>
  <PageHeader :title="view.title" :description="view.description">
    <template #badge>
      <span
        class="badge bg-orange-lt cursor-help"
        tabindex="0"
        title="日志不脱敏，含用户的文件内容与密钥：只有平台管理员能看，每次打开会话详情、每次下载都会写一条操作记录。上报账号和组织是客户端自己报的，未核验。"
      >未脱敏 · 仅平台管理员</span>
    </template>
    <template #actions>
      <button class="btn" type="button" @click="openSettings">{{ settingsLabel }}</button>
    </template>
  </PageHeader>
  <div class="page-body">
    <div class="container-fluid">
      <section aria-label="会话日志">
        <div v-show="!detailShown">
          <div class="card">
            <form class="card-body py-3" novalidate @submit.prevent="apply">
              <div class="d-flex flex-wrap align-items-center gap-2">
                <div class="input-icon flex-grow-1 log-search">
                  <span class="input-icon-addon"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0" /><path d="M21 21l-6 -6" /></svg></span>
                  <input v-model="form.search" class="form-control" type="search" maxlength="300" placeholder="搜索账号 ID、会话 ID（session-…）、Key（sk-… 或开头）" aria-label="按账号 ID、会话 ID 或 Key 搜索" @search="onSearch" />
                </div>
                <select v-model="form.organization" class="form-select w-auto" aria-label="按上报账号当前所属组织筛选" title="按上报账号当前所属组织筛选（未核验）" @change="apply">
                  <option value="">全部组织</option>
                  <option v-for="org in organizations" :key="org.id" :value="String(org.id)">{{ org.name }} (#{{ org.id }})</option>
                </select>
                <input v-model="form.model" class="form-select w-auto log-model" list="session-log-models" maxlength="200" placeholder="全部模型" aria-label="按模型筛选" title="按模型筛选：可从列表选，也可输入完整模型名" @change="apply" />
                <datalist id="session-log-models"><option v-for="model in modelList" :key="model" :value="model"></option></datalist>
                <select v-model="form.time" class="form-select w-auto" aria-label="按会话创建时间筛选" @change="onTime">
                  <option value="">全部时间</option>
                  <option value="24h">近 24 小时</option>
                  <option value="7d">近 7 天</option>
                  <option value="30d">近 30 天</option>
                  <option value="custom">自定义</option>
                </select>
                <button :class="['btn', moreOpen && 'active']" type="button" :aria-expanded="moreOpen ? 'true' : 'false'" aria-controls="session-log-more-filters" @click="moreOpen = !moreOpen">更多筛选</button>
                <button type="button" class="btn btn-ghost-secondary" @click="reset">重置</button>
                <button type="submit" class="visually-hidden" tabindex="-1">筛选</button>
              </div>
              <div v-show="moreOpen" id="session-log-more-filters" class="row g-2 mt-1">
                <div class="col-12 col-sm-6 col-xl-3"><input v-model="form.version" class="form-control" type="search" placeholder="客户端版本，如 0.7.19" aria-label="按客户端版本筛选" /></div>
                <div class="col-12 col-sm-6 col-xl-3"><input v-model="form.tag" class="form-control" type="search" placeholder="标签" aria-label="按标签筛选" maxlength="32" /></div>
                <div class="col-12 col-sm-6 col-xl-3">
                  <div class="input-group">
                    <span class="input-group-text">创建于</span><input v-model="form.from" class="form-control" type="date" aria-label="会话创建时间起（含）" @change="onDate" />
                  </div>
                </div>
                <div class="col-12 col-sm-6 col-xl-3">
                  <div class="input-group">
                    <span class="input-group-text">至</span><input v-model="form.to" class="form-control" type="date" aria-label="会话创建时间止（含）" @change="onDate" />
                  </div>
                </div>
              </div>
              <div v-if="chips.length" class="tags-list align-items-center mt-2">
                <span class="text-secondary small">已筛选：</span>
                <span v-for="chip in chips" :key="chip.label" class="tag">
                  <span>{{ chip.label }}</span><button type="button" class="btn-close" :aria-label="`去掉筛选 ${chip.label}`" @click="dropChip(chip)"></button>
                </span>
              </div>
            </form>
            <div class="card-body border-top border-bottom py-2 d-flex flex-wrap align-items-center gap-2">
              <div class="me-auto" aria-live="polite">
                <span class="fw-medium">{{ listLoaded ? summary : '' }}</span>
                <span class="text-secondary small ms-2">大小为压缩后实际写入的大小</span>
                <span v-if="listLoaded && !keyDisplayReady" class="text-warning small ms-2">未配置 Key 加密（服务端缺 MARKET_KEY_ENCRYPTION_SECRET），只能看到 Key 指纹</span>
              </div>
              <span class="d-flex flex-wrap align-items-center gap-2">
                <template v-if="selected.size">
                  <span class="text-secondary">已选 {{ selected.size }} 个</span>
                  <button type="button" :class="['btn', 'btn-outline-danger', 'btn-sm', rowBusy.has('bulk') && 'btn-loading']" :disabled="rowBusy.has('bulk')" @click="removeSelected">删除所选</button>
                </template>
                <RowActions name="会话日志" compact :busy="rowBusy.has('range')" :more="[{ label: '按日期删除…', danger: true, run: () => void removeRange() }]" />
              </span>
            </div>
            <div v-if="listLoading" class="progress progress-sm rounded-0 log-loading" aria-hidden="true"><div class="progress-bar progress-bar-indeterminate"></div></div>
            <div ref="table" class="table-responsive" :aria-busy="listLoading || undefined">
              <table class="table card-table table-vcenter table-hover log-table">
                <thead>
                  <tr>
                    <th scope="col" class="w-1">
                      <input
                        class="form-check-input m-0 align-middle"
                        type="checkbox"
                        aria-label="全选本页"
                        title="勾选后可批量删除；翻页或改筛选会清空勾选"
                        :checked="allChecked"
                        :indeterminate="someChecked"
                        :disabled="!items.length"
                        @change="checkAll(($event.target as HTMLInputElement).checked)"
                      />
                    </th>
                    <th scope="col">会话</th>
                    <th scope="col" title="客户端上报的账号，未核验；名称按此 ID 查得">账号</th>
                    <th scope="col" title="按上报账号查到的当前归属，不一定是上传时的，未核验">组织</th>
                    <th scope="col">Key</th>
                    <th scope="col">模型</th>
                    <th scope="col" class="text-end">Token</th>
                    <th scope="col" class="text-end">事件 · 大小</th>
                    <th scope="col">标签</th>
                    <th scope="col">最近上传</th>
                    <th scope="col" class="w-1"><span class="visually-hidden">操作</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in items" :key="nameOf(item)" :class="['cursor-pointer', selected.has(nameOf(item)) && 'table-active']" @click="rowClick($event, item)">
                    <td>
                      <input class="form-check-input m-0 align-middle" type="checkbox" :aria-label="`选择 ${titleOf(item)}`" :checked="selected.has(nameOf(item))" @change="check(item, ($event.target as HTMLInputElement).checked)" />
                    </td>
                    <td class="log-session">
                      <button type="button" class="btn btn-link p-0 text-reset fw-medium text-start text-break" @click="showSession(item)">{{ titleOf(item) }}</button>
                      <div class="text-secondary small">{{ clientMeta(item) }}</div>
                    </td>
                    <td :title="accountTitle(item.accountId)">
                      <span v-if="!item.accountId" class="text-secondary">—</span>
                      <template v-else>
                        <div class="text-break">{{ accountOf(item.accountId)?.name ?? item.accountId }}</div>
                        <div class="text-secondary small">{{ accountOf(item.accountId) ? `ID ${item.accountId}` : '' }}</div>
                      </template>
                    </td>
                    <td
                      :class="['text-break', !accountOf(item.accountId)?.organization && 'text-secondary']"
                      :title="organizationText(accountOf(item.accountId)) ? '按上报账号查到的当前归属，不一定是上传时的，未核验' : undefined"
                    >{{ organizationText(accountOf(item.accountId)) ?? '—' }}</td>
                    <td class="text-nowrap" :title="item.keyLabel && item.key ? shortKey(item.key) : undefined">
                      <span v-if="!item.keyFingerprint" class="text-secondary">匿名</span>
                      <template v-else>
                        <span v-if="item.keyLabel" class="badge bg-secondary-lt">{{ item.keyLabel }}</span>
                        <code v-else-if="item.key">{{ shortKey(item.key) }}</code>
                        <code v-else class="text-secondary">指纹 {{ item.keyFingerprint.slice(0, 8) }}</code>
                        <button v-if="item.key" type="button" class="btn btn-link btn-sm p-0 ms-2" @click="copyKey(item.key)">复制</button>
                      </template>
                    </td>
                    <td class="text-nowrap" :title="item.models.length > 1 ? item.models.join('、') : undefined">
                      <span v-if="!item.models.length" class="text-secondary">—</span>
                      <template v-else>
                        <span>{{ item.models[0] }}</span><span v-if="item.models.length > 1" class="badge bg-secondary-lt ms-1">+{{ item.models.length - 1 }}</span>
                      </template>
                    </td>
                    <td class="text-end text-nowrap">{{ tokenText(item.tokens.total) }}</td>
                    <td class="text-end text-nowrap">
                      <div>{{ item.eventCount }} 条 · {{ sizeText(item.storedBytes) }}</div>
                      <div v-if="item.missingEvents" class="text-warning small">缺 {{ item.missingEvents }} 条</div>
                    </td>
                    <td class="log-annotation">
                      <div v-if="item.tags.length" class="badges-list"><span v-for="tag in item.tags" :key="tag" class="badge bg-secondary-lt">{{ tag }}</span></div>
                      <div v-if="item.note" class="text-secondary small text-truncate" :title="item.note">{{ item.note }}</div>
                      <span v-if="!item.tags.length && !item.note" class="text-secondary">—</span>
                    </td>
                    <td class="text-nowrap" :title="`创建 ${time(item.createdAt ?? item.firstReceivedAt)} · 最近上传 ${time(item.lastReceivedAt)}`">{{ relativeTime(item.lastReceivedAt) }}</td>
                    <td><RowActions :name="titleOf(item)" compact :busy="rowBusy.has(nameOf(item))" :more="rowMenu(item)" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="listLoaded && !items.length" class="empty"><p class="empty-title">{{ emptyTitle }}</p></div>
            <div v-else-if="!listLoaded && listLoading" class="empty" role="status"><p class="empty-title text-secondary">正在加载…</p></div>
            <DataPager :page="page" :page-size="pageSize" :total="total" unit="个会话" size-unit="条" size-label="每页条数" label="会话列表分页" @go="goTo" @size="setPageSize" />
          </div>
        </div>
        <SessionLogDetail v-show="detailShown" ref="detail" :open-session="(id, formatVersion) => openSession(id, formatVersion, { push: true })" @back="leaveDetail" />
      </section>
    </div>
  </div>

  <FormDialog :open="note.open" id="session-log-note" title="备注与标签" :subtitle="note.item ? `${titleOf(note.item)} · ${note.item.id}` : ''" close-label="关闭备注编辑" :pending="note.pending" :error="note.error" @submit="saveNote" @close="note.open = false">
    <div class="mb-3">
      <label class="form-label" for="session-log-note-text">备注</label>
      <textarea id="session-log-note-text" v-model="note.text" class="form-control" rows="4" maxlength="2000" placeholder="只给后台看，不会改动日志内容"></textarea>
    </div>
    <div>
      <label class="form-label" for="session-log-note-tags">标签</label>
      <input id="session-log-note-tags" v-model="note.tags" class="form-control" maxlength="400" placeholder="用逗号分隔，例如：卡顿, 待跟进" />
      <div class="form-hint">最多 10 个标签，每个不超过 32 字。</div>
    </div>
  </FormDialog>

  <FormDialog :open="settings.open" id="session-log-settings" title="会话日志设置" size="sm" close-label="关闭会话日志设置" :pending="settings.pending" :error="settings.error" @submit="saveSettings" @close="settings.open = false">
    <label class="form-label" for="session-log-retention">保留天数</label>
    <input id="session-log-retention" v-model="settings.value" class="form-control" type="number" min="1" max="36500" step="1" placeholder="永久" aria-describedby="session-log-retention-note" />
    <div id="session-log-retention-note" class="form-hint">留空为永久保留；设置后每小时清理一次最近上传早于该天数的会话，删除后不可恢复。</div>
  </FormDialog>
</template>
