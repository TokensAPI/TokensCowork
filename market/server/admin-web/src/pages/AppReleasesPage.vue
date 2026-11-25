<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError, request } from '../api'
import { notify, runAction } from '../feedback'
import { confirmAction, confirmDiscard } from '../confirm'
import { shell, useRefresh, formatTime } from '../shell'
import { useRequest } from '../useRequest'
import { loadOrganizations, loadUsers, organizationLabel, type Organization } from '../directory'
import {
  loadAppReleases, loadAvailableReleases, loadReleaseBriefs, loadReleaseInfo, releaseUserLabel, scopePlan, scopeText, sizeText, STABLE_VERSION, STATUS,
  type AppRelease, type AvailableRelease, type Installations, type ReleaseBrief, type ReleaseInfo, type ReleaseStatus, type ReleaseUser,
} from '../appReleases'
import { ICONS, viewById } from '../views'
import AppIcon from '../components/AppIcon.vue'
import PageHeader from '../components/PageHeader.vue'
import ListCard from '../components/ListCard.vue'
import FormDialog from '../components/FormDialog.vue'

/**
 * The 版本发布 page: the desktop app versions in staged rollout. The list (#app-releases) says, per
 * version, which release it is and who receives it; a version opens on its own address
 * (#app-releases/<version>) with what GitHub says about it, its scope in three sections -- 先发
 * (always offered), 其余按比例 (the percentage of everyone else) and 暂缓 (never offered) -- its
 * progress, and its status with the actions. Anything that starts offering a version is confirmed
 * first. The back button, 「← 版本发布」 and Esc return to the list.
 */
interface Page {
  releases: AppRelease[]
  installations: Installations
  organizations: Organization[]
  searchReady: boolean
  briefs: ReleaseBrief[] | null
}
const view = viewById('app-releases')!
const route = useRoute()
const router = useRouter()
const page = useRequest<Page>(async () => {
  const [list, orgs, users, briefs] = await Promise.all([
    loadAppReleases(), loadOrganizations(), loadUsers().catch(() => ({ searchReady: false })),
    // What GitHub says is a help, not a need: without it the versions still list and can be set up.
    loadReleaseBriefs().then((answer) => answer.items).catch(() => null),
  ])
  return { releases: list.items, installations: list.installations, organizations: orgs.items, searchReady: users.searchReady, briefs }
})
const releases = computed(() => page.data.value?.releases ?? [])
const installations = computed(() => page.data.value?.installations ?? { days: 7, total: 0, versions: [] })
const organizations = computed(() => page.data.value?.organizations ?? [])
const briefOf = (version: string) => page.data.value?.briefs?.find((item) => item.version === version) ?? null
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')

async function load() {
  const ok = await page.run()
  if (ok) shell.lastRefresh = Date.now()
  return ok
}
async function reload(message: string) {
  if (await load()) notify(message)
  else notify(`${message} 但页面刷新失败：${page.error.value?.message ?? ''} 请刷新核对，无需重复保存。`, 'error')
}
useRefresh(async () => {
  if (!(await load())) throw page.error.value ?? new Error('刷新失败')
})

// ── 各版本安装数 ───────────────────────────────────────────────
const SHOWN_VERSIONS = 8
const bars = computed(() => {
  const { versions, total } = installations.value
  const shown = versions.slice(0, SHOWN_VERSIONS)
  const rest = versions.slice(SHOWN_VERSIONS).reduce((sum, item) => sum + item.count, 0)
  const rows = rest ? [...shown, { version: '更早版本', count: rest }] : shown
  return rows.map((row) => ({ ...row, share: total ? Math.round((row.count / total) * 1000) / 10 : 0 }))
})

// ── 新建 ───────────────────────────────────────────────────────
const MANUAL = '__manual__'
const create = reactive({ open: false, pending: false, error: '', choice: '', typed: '', note: '', available: [] as AvailableRelease[], listError: '', listLoading: false })
const offeredChoices = computed(() => create.available.filter((item) => !releases.value.some((release) => release.version === item.version)))
const typing = computed(() => !!create.listError || create.choice === MANUAL || (!create.listLoading && !offeredChoices.value.length))
const createVersion = computed(() => (typing.value ? create.typed.trim() : create.choice))
const choiceLabel = (item: AvailableRelease) => `${item.version} · ${item.prerelease ? '预发布' : '正式版'}${item.publishedAt ? ` · ${day(item.publishedAt)}` : ''}`
async function openCreate() {
  Object.assign(create, { open: true, pending: false, error: '', choice: '', typed: '', note: '', available: [], listError: '', listLoading: true })
  try {
    create.available = (await loadAvailableReleases()).items
    create.choice = offeredChoices.value[0]?.version ?? MANUAL
  } catch (error) {
    create.listError = error instanceof Error ? error.message : String(error)
  } finally {
    create.listLoading = false
  }
}
async function saveCreate() {
  const version = createVersion.value.replace(/^v/u, '')
  if (!STABLE_VERSION.test(version)) {
    create.error = '版本号须为稳定版格式 x.y.z'
    return
  }
  create.pending = true
  create.error = ''
  const ok = await runAction(() => request('/api/v1/app-releases', { version, note: create.note.trim() }, 'POST'), {
    onError: (message, cause) => { if (!(cause instanceof ApiError && cause.status === 401)) create.error = message },
  })
  create.pending = false
  if (!ok) return
  create.open = false
  await reload(`已新建草稿 ${version}。现在还没有人能收到，设置好范围后再开始发布。`)
  await open(version)
}

// ── 详情：打开与返回 ───────────────────────────────────────────
const shownVersion = computed(() => (typeof route.params.release === 'string' ? route.params.release : ''))
const current = computed(() => releases.value.find((release) => release.version === shownVersion.value) ?? null)
let listScroll = 0
async function open(version: string) {
  if (!shownVersion.value) listScroll = window.scrollY
  await router.push({ path: `/app-releases/${version}`, state: { appReleaseOpened: true } })
}
async function back() {
  if (dirty.value && !(await confirmDiscard())) return
  discard()
  if ((history.state as { appReleaseOpened?: boolean } | null)?.appReleaseOpened) router.back()
  else await router.replace('/app-releases')
}
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || !shownVersion.value || document.querySelector('dialog[open]')) return
  void back()
}
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value) event.preventDefault()
}

// ── 详情：版本信息 ─────────────────────────────────────────────
const info = reactive({ version: '', loading: false, data: null as ReleaseInfo | null, error: '' })
const SHOWN_POINTS = 6
const allPoints = ref(false)
const pointCount = computed(() => info.data?.highlights.reduce((sum, section) => sum + section.items.length, 0) ?? 0)
const shownHighlights = computed(() => {
  let left = allPoints.value ? Infinity : SHOWN_POINTS
  return (info.data?.highlights ?? []).map((section) => {
    const items = section.items.slice(0, Math.max(0, left))
    left -= items.length
    return { title: section.title, items }
  }).filter((section) => section.items.length)
})
async function loadInfo(version: string) {
  Object.assign(info, { version, loading: true, data: null, error: '' })
  allPoints.value = false
  try {
    const data = await loadReleaseInfo(version)
    if (info.version === version) info.data = data
  } catch (error) {
    if (info.version === version) info.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (info.version === version) info.loading = false
  }
}

// ── 详情：推送范围（先改草稿，保存才生效） ─────────────────────
type Kind = 'early' | 'hold'
const draft = reactive({ version: '', percent: 0, note: '', early: [] as number[], hold: [] as number[], earlyUsers: [] as ReleaseUser[], holdUsers: [] as ReleaseUser[] })
const snapshot = (source: Pick<AppRelease, 'percent' | 'note' | 'early' | 'hold' | 'earlyUsers' | 'holdUsers'>) => JSON.stringify([
  source.percent, source.note.trim(), [...source.early].sort((a, b) => a - b), [...source.hold].sort((a, b) => a - b),
  source.earlyUsers.map((user) => user.id).sort((a, b) => a - b), source.holdUsers.map((user) => user.id).sort((a, b) => a - b),
])
function discard() {
  const release = current.value
  if (!release) return
  Object.assign(draft, { version: release.version, percent: release.percent, note: release.note, early: [...release.early], hold: [...release.hold],
    earlyUsers: release.earlyUsers.map((user) => ({ ...user })), holdUsers: release.holdUsers.map((user) => ({ ...user })) })
}
const dirty = computed(() => !!current.value && draft.version === current.value.version && snapshot(draft) !== snapshot(current.value))
const percentValid = computed(() => Number.isInteger(draft.percent) && draft.percent >= 0 && draft.percent <= 100)
const estimate = computed(() => (installations.value.total && percentValid.value ? Math.round((installations.value.total * draft.percent) / 100) : null))
const orgList = (kind: Kind) => draft[kind]
const userList = (kind: Kind) => (kind === 'early' ? draft.earlyUsers : draft.holdUsers)
function dropOrg(kind: Kind, id: number) {
  draft[kind] = draft[kind].filter((item) => item !== id)
}
function dropUser(kind: Kind, id: number) {
  if (kind === 'early') draft.earlyUsers = draft.earlyUsers.filter((user) => user.id !== id)
  else draft.holdUsers = draft.holdUsers.filter((user) => user.id !== id)
}
const SECTION: Record<Kind, { title: string; lead: string; empty: string }> = {
  early: { title: '先发', lead: '名单里的组织和用户一定会主动看到这个版本，不看比例。', empty: '还没有先发的组织或用户。' },
  hold: { title: '暂缓', lead: '名单里的组织和用户不会收到这个版本，自己点「检查更新」也不会。', empty: '没有暂缓的组织或用户。' },
}

// The opened version's draft follows the server copy until it is edited; a refresh never
// overwrites unsaved changes.
watch([shownVersion, current], ([version, release], [oldVersion]) => {
  if (!version || !release) return
  if (version !== oldVersion || draft.version !== version || !dirty.value) discard()
  if (info.version !== version) void loadInfo(version)
  if (version !== oldVersion) window.scrollTo(0, 0)
}, { immediate: true })
watch(shownVersion, (version, old) => {
  if (!version && old) requestAnimationFrame(() => window.scrollTo(0, listScroll))
})

// ── 详情：添加组织或用户 ───────────────────────────────────────
interface Found { id: number; name: string; username?: string }
const adder = reactive({ open: false, kind: 'early' as Kind, orgTerm: '', keyword: '', searching: false, found: null as Found[] | null, userId: '', error: '' })
function openAdder(kind: Kind) {
  Object.assign(adder, { open: true, kind, orgTerm: '', keyword: '', searching: false, found: null, userId: '', error: '' })
}
const orgTaken = (id: number) => (draft.early.includes(id) ? 'early' : draft.hold.includes(id) ? 'hold' : null)
const userTaken = (id: number) => (draft.earlyUsers.some((user) => user.id === id) ? 'early' : draft.holdUsers.some((user) => user.id === id) ? 'hold' : null)
const adderOrgs = computed(() => {
  const term = adder.orgTerm.trim().toLowerCase()
  return organizations.value.filter((org) => `${org.name} ${org.id}`.toLowerCase().includes(term))
})
const takenText = (taken: Kind | null) => (taken === null ? '' : taken === adder.kind ? '已添加' : `已在${SECTION[taken].title}名单`)
function addOrg(id: number) {
  if (!orgTaken(id)) draft[adder.kind] = [...draft[adder.kind], id]
}
function addUser(user: ReleaseUser) {
  if (userTaken(user.id)) return
  if (adder.kind === 'early') draft.earlyUsers = [...draft.earlyUsers, user]
  else draft.holdUsers = [...draft.holdUsers, user]
}
async function searchUsers() {
  const keyword = adder.keyword.trim()
  if (!keyword || adder.searching) return
  adder.searching = true
  adder.error = ''
  await runAction(async () => {
    adder.found = (await request<{ items: Found[] }>(`/api/v1/users/search?keyword=${encodeURIComponent(keyword)}`)).items
  }, { onError: (message) => (adder.error = message) })
  adder.searching = false
}
function addUserById() {
  const id = Number(adder.userId)
  if (!Number.isSafeInteger(id) || id <= 0) {
    adder.error = '用户 ID 须为正整数'
    return
  }
  adder.error = ''
  addUser({ id, name: null })
  adder.userId = ''
}

// ── 详情：保存与状态操作 ───────────────────────────────────────
const busy = ref(false)
const planItems = (): [string, string, string] => {
  const release = { ...current.value!, percent: draft.percent, early: draft.early, hold: draft.hold, earlyUsers: draft.earlyUsers, holdUsers: draft.holdUsers }
  const names = (ids: number[], users: ReleaseUser[]) => [...ids.map((id) => organizationLabel(organizations.value, id)), ...users.map(releaseUserLabel)].join('、') || '无'
  return [`先发：${names(release.early, release.earlyUsers)}`, `其余的人：${release.status === 'full' ? '全部' : `${release.percent}%`}`, `暂缓：${names(release.hold, release.holdUsers)}`]
}
async function save() {
  const release = current.value
  if (!release || busy.value || !dirty.value) return
  if (!percentValid.value) return notify('比例须为 0-100 的整数', 'error')
  if (release.status === 'rolling' || release.status === 'full') {
    const confirmed = await confirmAction({
      title: `保存 ${release.version} 的范围？`, ok: '保存并生效', danger: false,
      text: `这个版本${STATUS[release.status].name}，保存后立即生效：`, items: planItems(),
    })
    if (!confirmed) return
  }
  busy.value = true
  const data = { ...(release.status === 'full' ? {} : { percent: draft.percent }), note: draft.note.trim(), early: draft.early, hold: draft.hold,
    earlyUsers: draft.earlyUsers.map((user) => user.id), holdUsers: draft.holdUsers.map((user) => user.id) }
  try {
    if (await runAction(() => request(`/api/v1/app-releases/${release.version}`, data, 'PATCH'))) {
      draft.version = ''
      await reload(`${release.version} 的范围已保存${release.status === 'draft' ? '，开始发布后生效' : ''}。`)
    }
  } finally {
    busy.value = false
  }
}
type ActionName = 'start' | 'resume' | 'full' | 'pause'
const ACTION: Record<ActionName, { title: (version: string) => string; ok: string; text: string; done: string; danger?: boolean }> = {
  start: { title: (v) => `开始发布 ${v}？`, ok: '开始发布', text: '确认后马上生效。任何人自己点「检查更新」也能拿到这个版本（暂缓名单除外）。可以随时暂停。', done: '已开始发布' },
  resume: { title: (v) => `继续发布 ${v}？`, ok: '继续发布', text: '确认后马上按下面的范围继续提供。', done: '已继续发布' },
  full: { title: (v) => `${v} 改为全量？`, ok: '改为全量', text: '除暂缓名单外，所有人都会看到这个版本。0.7.19 及更早的应用只认 GitHub 上的正式版，还需要把它转为正式版。', done: '已改为全量' },
  pause: { title: (v) => `暂停 ${v}？`, ok: '暂停', text: '暂停后不再提供给任何人，手动检查更新也收不到；已经装上的人不受影响。可以再继续。', done: '已暂停', danger: true },
}
async function act(name: ActionName, status: ReleaseStatus) {
  const release = current.value
  if (!release || busy.value) return
  if (dirty.value) return notify('范围有未保存的修改，请先保存或撤销。', 'error')
  const action = ACTION[name]
  const full = status === 'full'
  const confirmed = await confirmAction({
    title: action.title(release.version), ok: action.ok, danger: !!action.danger, text: action.text,
    items: status === 'paused' ? [] : full ? [planItems()[0], '其余的人：全部', planItems()[2]] : planItems(),
  })
  if (!confirmed) return
  busy.value = true
  try {
    if (await runAction(() => request(`/api/v1/app-releases/${release.version}`, { status }, 'PATCH'))) await reload(`${release.version} ${action.done}。`)
  } finally {
    busy.value = false
  }
}
async function remove() {
  const release = current.value
  if (!release || busy.value) return
  const confirmed = await confirmAction({ title: `删除草稿 ${release.version}？`, ok: '删除', text: '草稿还没给任何人，删除后可以重新新建。' })
  if (!confirmed) return
  busy.value = true
  try {
    if (await runAction(() => request(`/api/v1/app-releases/${release.version}`, undefined, 'DELETE'))) {
      draft.version = ''
      await router.replace('/app-releases')
      await reload(`草稿 ${release.version} 已删除。`)
    }
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void load()
  document.addEventListener('keydown', onKey)
  window.addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <!-- 列表 -->
  <template v-if="!shownVersion">
    <PageHeader :title="view.title" :description="view.description">
      <template #actions>
        <button class="btn btn-primary" type="button" @click="openCreate"><AppIcon :paths="ICONS.plus" />新建版本</button>
      </template>
    </PageHeader>
    <div class="page-body">
      <div class="container-fluid">
        <section v-if="page.data.value" class="card mb-3" aria-labelledby="installs-title">
          <div class="card-header">
            <div>
              <h3 id="installs-title" class="card-title">各版本安装数</h3>
              <div class="card-subtitle">最近 {{ installations.days }} 天检查过更新的 {{ installations.total }} 台安装，按当前版本</div>
            </div>
          </div>
          <div class="card-body">
            <p v-if="!bars.length" class="text-secondary mb-0">还没有客户端检查过更新。</p>
            <div v-for="bar in bars" :key="bar.version" class="install-row">
              <span class="install-version font-monospace">{{ bar.version }}</span>
              <div class="progress progress-sm flex-fill" role="presentation"><div class="progress-bar" :style="{ width: `${bar.share}%` }"></div></div>
              <span class="install-count">{{ bar.count }} 台 · {{ bar.share }}%</span>
            </div>
          </div>
        </section>

        <section aria-label="版本">
          <ListCard
            :loading="page.loading.value"
            :ready="!!page.data.value"
            :error="page.error.value?.message"
            :count="releases.length"
            empty-title="还没有要发布的版本"
            empty-subtitle="新版本构建成预发布后，点「新建版本」把它加进来，再决定先给谁。"
            @retry="load"
          >
            <template #head>
              <th scope="col">版本</th>
              <th scope="col">谁能收到</th>
              <th scope="col" class="text-nowrap">已提供 / 已升级</th>
              <th scope="col" class="w-1"><span class="visually-hidden">操作</span></th>
            </template>
            <tr v-for="release in releases" :key="release.version" class="release-row" @click="open(release.version)">
              <td class="release-cell">
                <div class="d-flex flex-wrap align-items-center gap-2">
                  <span class="fw-bold font-monospace">{{ release.version }}</span>
                  <span v-if="briefOf(release.version)" :class="['badge', briefOf(release.version)!.prerelease ? 'bg-yellow-lt' : 'bg-green-lt']">{{ briefOf(release.version)!.prerelease ? '预发布' : '正式版' }}</span>
                  <span v-if="day(briefOf(release.version)?.publishedAt)" class="text-secondary small">{{ day(briefOf(release.version)?.publishedAt) }}</span>
                </div>
                <div v-if="briefOf(release.version)?.summary" class="text-secondary small release-summary">{{ briefOf(release.version)!.summary }}</div>
                <div v-if="release.note" class="small text-break">备注：{{ release.note }}</div>
              </td>
              <td class="release-cell">
                <span :class="['badge', `bg-${STATUS[release.status].color}-lt`, 'me-2']">{{ STATUS[release.status].name }}</span>
                <span class="text-break">{{ scopeText(release) }}</span>
              </td>
              <td class="text-nowrap">{{ release.offered }} / {{ release.upgraded }}</td>
              <td><button class="btn btn-sm" type="button" :aria-label="`${release.version} 查看与设置`" @click.stop="open(release.version)">查看与设置</button></td>
            </tr>
            <template #footer>
              <div v-if="page.data.value" class="card-footer text-secondary">
                共 {{ releases.length }} 个版本，点一行查看版本信息并设置谁能收到。「已提供」= 正在运行该版本，或最近一次检查得到了它的安装；「已升级」= 正在运行它的安装；都只算最近 {{ installations.days }} 天检查过更新的。
              </div>
            </template>
          </ListCard>
        </section>
      </div>
    </div>
  </template>

  <!-- 详情 -->
  <template v-else>
    <div class="page-header">
      <div class="container-fluid">
        <button type="button" class="btn btn-ghost-primary btn-sm px-2 mb-2" title="返回列表（Esc）" @click="back">← 版本发布</button>
        <div class="d-flex flex-wrap align-items-center gap-2">
          <h2 class="page-title font-monospace mb-0">{{ shownVersion }}</h2>
          <template v-if="current">
            <span v-if="info.data" :class="['badge', info.data.prerelease ? 'bg-yellow-lt' : 'bg-green-lt']">{{ info.data.prerelease ? '预发布' : '正式版' }}</span>
            <span :class="['badge', `bg-${STATUS[current.status].color}-lt`]">{{ STATUS[current.status].name }}</span>
          </template>
        </div>
        <p v-if="info.data?.summary" class="text-secondary mt-2 mb-0 release-summary">{{ info.data.summary }}</p>
      </div>
    </div>
    <div class="page-body">
      <div class="container-fluid">
        <div v-if="!page.data.value" class="card"><div class="empty" role="status"><p class="empty-title text-secondary">{{ page.error.value ? `加载失败：${page.error.value.message}` : '正在加载…' }}</p></div></div>
        <div v-else-if="!current" class="card">
          <div class="empty">
            <p class="empty-title">没有 {{ shownVersion }} 这个发布</p>
            <p class="empty-subtitle text-secondary">它可能已被删除。</p>
            <div class="empty-action"><button class="btn" type="button" @click="back">返回版本发布</button></div>
          </div>
        </div>
        <template v-else>
          <!-- 1 状态与操作 -->
          <section class="card mb-3" aria-labelledby="release-state-title">
            <div class="card-body">
              <div class="d-flex flex-wrap align-items-start gap-3">
                <div class="flex-fill release-state">
                  <h3 id="release-state-title" class="card-title mb-1">现在：{{ STATUS[current.status].name }}</h3>
                  <p class="text-secondary mb-0">{{ STATUS[current.status].meaning }}</p>
                </div>
                <div class="btn-list">
                  <button v-if="current.status === 'draft'" class="btn btn-primary" type="button" :disabled="busy" @click="act('start', 'rolling')">开始发布</button>
                  <button v-if="current.status === 'paused'" class="btn btn-primary" type="button" :disabled="busy" @click="act('resume', 'rolling')">继续发布</button>
                  <button v-if="current.status === 'rolling' || current.status === 'paused'" class="btn" type="button" :disabled="busy" @click="act('full', 'full')">改为全量</button>
                  <button v-if="current.status === 'rolling' || current.status === 'full'" class="btn btn-outline-danger" type="button" :disabled="busy" @click="act('pause', 'paused')">暂停</button>
                  <button v-if="current.status === 'draft'" class="btn btn-ghost-danger" type="button" :disabled="busy" @click="remove">删除草稿</button>
                </div>
              </div>
            </div>
          </section>

          <!-- 2 推送范围 -->
          <section class="card mb-3" aria-labelledby="release-scope-title">
            <div class="card-header">
              <div>
                <h3 id="release-scope-title" class="card-title">谁能收到</h3>
                <div class="card-subtitle">按下面三段从上到下判断。同一个人既被点名、所在组织又有设置时，以对这个人的设置为准。</div>
              </div>
            </div>
            <div class="card-body">
              <div class="row g-3">
                <template v-for="kind in (['early', 'rest', 'hold'] as const)" :key="kind">
                  <div v-if="kind !== 'rest'" class="col-lg-4">
                    <div :class="['scope-box', `scope-${kind}`]">
                      <div class="d-flex align-items-center mb-1">
                        <h4 class="scope-title mb-0">{{ SECTION[kind].title }}</h4>
                        <button class="btn btn-sm ms-auto" type="button" :disabled="busy" @click="openAdder(kind)"><AppIcon :paths="ICONS.plus" />添加</button>
                      </div>
                      <p class="text-secondary small mb-2">{{ SECTION[kind].lead }}</p>
                      <p v-if="!orgList(kind).length && !userList(kind).length" class="text-secondary mb-0">{{ SECTION[kind].empty }}</p>
                      <ul v-else class="list-unstyled mb-0 scope-list">
                        <li v-for="id in orgList(kind)" :key="`o${id}`" class="scope-item">
                          <span class="badge bg-secondary-lt">组织</span>
                          <span class="text-break flex-fill">{{ organizationLabel(organizations, id) }}</span>
                          <button class="btn btn-sm btn-ghost-secondary px-2" type="button" :aria-label="`从${SECTION[kind].title}移除 ${organizationLabel(organizations, id)}`" :disabled="busy" @click="dropOrg(kind, id)">移除</button>
                        </li>
                        <li v-for="user in userList(kind)" :key="`u${user.id}`" class="scope-item">
                          <span class="badge bg-azure-lt">用户</span>
                          <span class="text-break flex-fill">{{ releaseUserLabel(user) }}<span v-if="user.organization?.name" class="text-secondary"> · {{ user.organization.name }}</span></span>
                          <button class="btn btn-sm btn-ghost-secondary px-2" type="button" :aria-label="`从${SECTION[kind].title}移除 ${releaseUserLabel(user)}`" :disabled="busy" @click="dropUser(kind, user.id)">移除</button>
                        </li>
                      </ul>
                    </div>
                  </div>
                  <div v-else class="col-lg-4">
                    <div class="scope-box scope-rest">
                      <h4 class="scope-title mb-1">其余的人：按比例</h4>
                      <p class="text-secondary small mb-2">不在两份名单里的安装，约有这个比例会主动看到更新。自己点「检查更新」的人不受比例限制。</p>
                      <div class="d-flex align-items-center gap-2">
                        <input v-model.number="draft.percent" class="form-range flex-fill" type="range" min="0" max="100" step="1" :disabled="busy || current.status === 'full'" aria-label="比例滑块" />
                        <input id="release-percent" :value="current.status === 'full' ? 100 : draft.percent" class="form-control percent-input" type="number" min="0" max="100" step="1" aria-label="比例（%）"
                          :disabled="busy || current.status === 'full'" @input="draft.percent = Number(($event.target as HTMLInputElement).value)" />
                        <span>%</span>
                      </div>
                      <p class="small mb-0 mt-2">
                        <template v-if="current.status === 'full'">全量：其余的人全部能收到。</template>
                        <template v-else-if="estimate !== null">按最近 {{ installations.days }} 天的 {{ installations.total }} 台安装估算，约 {{ estimate }} 台（未扣除名单里的）。</template>
                        <template v-else>还没有安装数据，暂时无法估算台数。</template>
                      </p>
                    </div>
                  </div>
                </template>
              </div>
              <div class="mt-3">
                <label class="form-label" for="release-note">备注</label>
                <input id="release-note" v-model="draft.note" class="form-control" maxlength="200" placeholder="例如 先给内部组织试用一周" :disabled="busy" />
              </div>
            </div>
            <div class="card-footer d-flex flex-wrap align-items-center gap-2">
              <span class="text-secondary small me-auto">
                <template v-if="dirty">有未保存的修改{{ current.status === 'rolling' || current.status === 'full' ? '，保存后立即生效' : '' }}。</template>
                <template v-else>上次修改 {{ formatTime(current.updatedAt) }}</template>
              </span>
              <button class="btn" type="button" :disabled="!dirty || busy" @click="discard">撤销修改</button>
              <button :class="['btn btn-primary', busy && 'btn-loading']" type="button" :disabled="!dirty || busy || !percentValid" @click="save">保存范围</button>
            </div>
          </section>

          <!-- 3 进度 -->
          <section class="card mb-3" aria-labelledby="release-progress-title">
            <div class="card-header"><h3 id="release-progress-title" class="card-title">进度</h3></div>
            <div class="card-body">
              <div class="row g-3">
                <div class="col-6 col-md-3"><div class="text-secondary small">已提供</div><div class="h2 mb-0">{{ current.offered }} <span class="fs-5 fw-normal text-secondary">台</span></div></div>
                <div class="col-6 col-md-3"><div class="text-secondary small">已升级</div><div class="h2 mb-0">{{ current.upgraded }} <span class="fs-5 fw-normal text-secondary">台</span></div></div>
              </div>
              <p class="text-secondary small mb-0 mt-2">「已提供」= 正在运行这个版本，或最近一次检查更新时得到了它的安装；「已升级」= 正在运行它的安装。都只算最近 {{ installations.days }} 天检查过更新的。</p>
            </div>
          </section>

          <!-- 4 版本信息 -->
          <section class="card" aria-labelledby="release-info-title">
            <div class="card-header">
              <h3 id="release-info-title" class="card-title">版本信息</h3>
              <div v-if="info.data?.url" class="card-actions"><a class="btn btn-sm" :href="info.data.url" target="_blank" rel="noopener noreferrer">在 GitHub 查看</a></div>
            </div>
            <div v-if="info.loading" class="card-body text-secondary" role="status">正在读取版本信息…</div>
            <div v-else-if="!info.data" class="card-body">
              <p class="mb-1">读不到这个版本的信息。</p>
              <p class="text-secondary small mb-2 text-break">{{ info.error }}　不影响上面的设置。</p>
              <button class="btn btn-sm" type="button" @click="loadInfo(shownVersion)">重试</button>
            </div>
            <div v-else class="card-body">
              <p class="text-secondary small mb-2">{{ info.data.prerelease ? '预发布' : '正式版' }}<template v-if="info.data.publishedAt"> · 发布于 {{ formatTime(Date.parse(info.data.publishedAt)) }}</template></p>
              <p v-if="info.data.summary" class="mb-3">{{ info.data.summary }}</p>
              <template v-if="shownHighlights.length">
                <h4 class="scope-title">本次更新</h4>
                <div v-for="section in shownHighlights" :key="section.title" class="mb-2">
                  <div v-if="section.title" class="fw-medium">{{ section.title }}</div>
                  <ul class="mb-0 ps-3"><li v-for="item in section.items" :key="item" class="text-break">{{ item }}</li></ul>
                </div>
                <button v-if="pointCount > SHOWN_POINTS" class="btn btn-sm btn-ghost-primary px-2 mb-3" type="button" @click="allPoints = !allPoints">{{ allPoints ? '收起' : `展开全部 ${pointCount} 条` }}</button>
              </template>
              <div class="row g-3 mt-0">
                <div v-if="info.data.components.length" class="col-md-6">
                  <h4 class="scope-title">内置组件与插件</h4>
                  <table class="table table-sm mb-0">
                    <tbody><tr v-for="item in info.data.components" :key="item.name"><td class="text-break">{{ item.name }}</td><td class="font-monospace text-nowrap">{{ item.version }}</td></tr></tbody>
                  </table>
                </div>
                <div v-if="info.data.installers.length" class="col-md-6">
                  <h4 class="scope-title">安装包</h4>
                  <table class="table table-sm mb-0">
                    <tbody>
                      <tr v-for="item in info.data.installers" :key="item.name">
                        <td class="text-break"><a v-if="item.url" :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.name }}</a><template v-else>{{ item.name }}</template></td>
                        <td class="text-nowrap text-secondary">{{ sizeText(item.size) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>
        </template>
      </div>
    </div>
  </template>

  <FormDialog :open="create.open" id="release-create" title="新建版本" close-label="关闭新建版本" :pending="create.pending" :error="create.error" @submit="saveCreate" @close="create.open = false">
    <div class="mb-3">
      <label class="form-label" :for="typing ? 'release-version' : 'release-choice'">版本号</label>
      <select v-if="!create.listError && !create.listLoading && offeredChoices.length" id="release-choice" v-model="create.choice" class="form-select mb-2">
        <option v-for="item in offeredChoices" :key="item.version" :value="item.version">{{ choiceLabel(item) }}</option>
        <option :value="MANUAL">手动填写…</option>
      </select>
      <input v-if="typing" id="release-version" v-model="create.typed" class="form-control font-monospace" maxlength="20" placeholder="例如 0.8.0" autocomplete="off" spellcheck="false" required />
      <div class="form-hint">
        {{ create.listLoading ? '正在读取 GitHub 发布列表…' : create.listError ? `${create.listError}。` : offeredChoices.length ? '从 GitHub 发布列表选择，或手动填写稳定版 x.y.z。' : 'GitHub 发布列表里的版本都已添加，请手动填写稳定版 x.y.z。' }}
      </div>
    </div>
    <div class="mb-3">
      <label class="form-label" for="release-create-note">备注</label>
      <input id="release-create-note" v-model="create.note" class="form-control" maxlength="200" placeholder="例如 先给内部组织试用" />
    </div>
    <div class="form-hint">新建后是草稿，谁都收不到；接着设置先发、比例和暂缓，再开始发布。</div>
  </FormDialog>

  <FormDialog :open="adder.open" id="release-adder" :kicker="shownVersion" :title="`添加到${SECTION[adder.kind].title}名单`" close-label="关闭添加" submit-label="完成" :error="adder.error" error-class="" scrollable
    @submit="adder.open = false" @close="adder.open = false">
    <p class="text-secondary small">{{ SECTION[adder.kind].lead }} 点一下就加入，保存范围后才生效。</p>
    <div class="mb-3">
      <label class="form-label" for="adder-org">组织</label>
      <input id="adder-org" v-model="adder.orgTerm" class="form-control mb-2" type="search" placeholder="搜索组织名称或组织号" />
      <div class="list-group grant-list">
        <button v-for="org in adderOrgs" :key="org.id" type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2" :disabled="!!orgTaken(org.id)" @click="addOrg(org.id)">
          <span class="text-break">{{ org.name }} <span class="text-secondary">#{{ org.id }}</span></span>
          <span v-if="!org.enabled" class="badge bg-secondary-lt">已停用</span>
          <span class="ms-auto text-secondary small text-nowrap">{{ takenText(orgTaken(org.id)) || '添加' }}</span>
        </button>
        <div v-if="!adderOrgs.length" class="list-group-item text-secondary">{{ organizations.length ? '没有匹配的组织。' : '还没有登记组织，先到「组织」页同步。' }}</div>
      </div>
    </div>
    <div>
      <label class="form-label" for="adder-user">用户</label>
      <div v-if="page.data.value?.searchReady" class="input-group mb-2">
        <input id="adder-user" v-model="adder.keyword" class="form-control" type="search" maxlength="100" placeholder="用户名或显示名" @keydown.enter.prevent="searchUsers" />
        <button :class="['btn', adder.searching && 'btn-loading']" type="button" :disabled="adder.searching" @click="searchUsers">搜索</button>
      </div>
      <div v-if="adder.found" class="list-group grant-list mb-2">
        <button v-for="user in adder.found" :key="user.id" type="button" class="list-group-item list-group-item-action d-flex align-items-center gap-2" :disabled="!!userTaken(user.id)" @click="addUser({ id: user.id, name: user.name })">
          <span class="text-break">{{ user.name }}<template v-if="user.username && user.username !== user.name"> · {{ user.username }}</template> <span class="text-secondary">#{{ user.id }}</span></span>
          <span class="ms-auto text-secondary small text-nowrap">{{ takenText(userTaken(user.id)) || '添加' }}</span>
        </button>
        <div v-if="!adder.found.length" class="list-group-item text-secondary">没有找到匹配的用户。</div>
      </div>
      <div class="input-group">
        <input v-model="adder.userId" class="form-control" type="number" min="1" step="1" placeholder="或直接填 TokensAPI 用户 ID" aria-label="TokensAPI 用户 ID" @keydown.enter.prevent="addUserById" />
        <button class="btn" type="button" @click="addUserById">按 ID 添加</button>
      </div>
      <div class="form-hint">没有登录的安装无法点名，只能按比例。</div>
    </div>
  </FormDialog>
</template>
