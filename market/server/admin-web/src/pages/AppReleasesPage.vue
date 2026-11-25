<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ApiError, request } from '../api'
import { notify, runAction } from '../feedback'
import { confirmAction } from '../confirm'
import { shell, useRefresh, formatTime } from '../shell'
import { useRequest } from '../useRequest'
import { loadOrganizations, organizationLabel, type Organization } from '../directory'
import {
  loadAppReleases, loadAvailableReleases, reachText, STABLE_VERSION, STATUS,
  type AppRelease, type AvailableRelease, type Installations, type ReleaseStatus,
} from '../appReleases'
import { ICONS, viewById } from '../views'
import AppIcon from '../components/AppIcon.vue'
import PageHeader from '../components/PageHeader.vue'
import ListCard from '../components/ListCard.vue'
import RowActions from '../components/RowActions.vue'
import FormDialog from '../components/FormDialog.vue'

/**
 * The 版本发布 page (#app-releases): the desktop app versions in staged rollout. Each version goes
 * first to the organizations on its early list, then to a percentage of everyone else, never to
 * those on its hold list; it can be paused at any time and finally given to everyone. The update
 * plugin asks /v1/app/update; the counts on this page come from those checks (last 7 days).
 */
interface Page {
  releases: AppRelease[]
  installations: Installations
  organizations: Organization[]
}
const view = viewById('app-releases')!
const page = useRequest<Page>(async () => {
  const [list, orgs] = await Promise.all([loadAppReleases(), loadOrganizations()])
  return { releases: list.items, installations: list.installations, organizations: orgs.items }
})
const releases = computed(() => page.data.value?.releases ?? [])
const installations = computed(() => page.data.value?.installations ?? { days: 7, total: 0, versions: [] })
const organizations = computed(() => page.data.value?.organizations ?? [])

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
onMounted(load)

const orgNames = (ids: number[]) => (ids.length ? ids.map((id) => organizationLabel(organizations.value, id)).join('、') : '—')

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
const choiceLabel = (item: AvailableRelease) =>
  `${item.version} · ${item.prerelease ? '预发布' : '正式版'}${item.publishedAt ? ` · ${item.publishedAt.slice(0, 10)}` : ''}`
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
  const version = createVersion.value
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
  await reload(`已新建草稿 ${version.replace(/^v/u, '')}，点「编辑」选先发组织和比例，再开始发布。`)
}

// ── 编辑 ───────────────────────────────────────────────────────
type Placement = '' | 'early' | 'hold'
const form = reactive({ open: false, pending: false, error: '', version: '', original: 'draft' as ReleaseStatus, updatedAt: 0, status: 'draft' as ReleaseStatus, percent: 0, note: '', search: '', placement: {} as Record<number, Placement> })
const statusChoices = computed(() => (Object.keys(STATUS) as ReleaseStatus[]).filter((status) => status !== 'draft' || form.original === 'draft'))
const visibleOrgs = computed(() => {
  const term = form.search.trim().toLowerCase()
  return organizations.value.filter((org) => `${org.name} ${org.id}`.toLowerCase().includes(term))
})
const chosen = (kind: Placement) => Object.entries(form.placement).filter(([, value]) => value === kind).map(([id]) => Number(id))
const placementSummary = computed(() => `先发 ${chosen('early').length} 个组织 · 暂缓 ${chosen('hold').length} 个组织`)
function edit(release: AppRelease) {
  const placement: Record<number, Placement> = {}
  for (const id of release.early) placement[id] = 'early'
  for (const id of release.hold) placement[id] = 'hold'
  Object.assign(form, { open: true, pending: false, error: '', version: release.version, original: release.status, updatedAt: release.updatedAt, status: release.status,
    percent: release.percent, note: release.note, search: '', placement })
}
async function saveEdit() {
  const percent = Number(form.percent)
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    form.error = '比例须为 0-100 的整数'
    return
  }
  form.pending = true
  form.error = ''
  const data = { status: form.status, ...(form.status === 'full' ? {} : { percent }), note: form.note.trim(), early: chosen('early'), hold: chosen('hold') }
  const ok = await runAction(() => request(`/api/v1/app-releases/${form.version}`, data, 'PATCH'), {
    onError: (message, cause) => { if (!(cause instanceof ApiError && cause.status === 401)) form.error = message },
  })
  form.pending = false
  if (!ok) return
  form.open = false
  await reload(`${form.version} 已保存。`)
}

// ── 行操作 ─────────────────────────────────────────────────────
const busy = ref<string | null>(null)
async function setStatus(release: AppRelease, status: ReleaseStatus) {
  if (busy.value) return
  if (status === 'rolling' && release.status === 'draft') {
    const confirmed = await confirmAction({
      title: `开始发布 ${release.version}？`, ok: '开始发布',
      text: `先发组织（${release.early.length} 个）马上能收到；其他人按比例（当前 ${release.percent}%）；用户手动检查更新时不看比例，也能收到。暂缓组织始终收不到。可以随时暂停。`,
    })
    if (!confirmed) return
  }
  if (status === 'full') {
    const confirmed = await confirmAction({
      title: `${release.version} 改为全量？`, ok: '改为全量',
      text: `除暂缓组织（${release.hold.length} 个）外，所有新客户端检查更新时都会收到它。老客户端只认 GitHub 稳定版，仍需在 GitHub 上把它转为正式版。`,
    })
    if (!confirmed) return
  }
  busy.value = release.version
  try {
    if (await runAction(() => request(`/api/v1/app-releases/${release.version}`, { status }, 'PATCH')))
      await reload(`${release.version} ${{ draft: '已改为草稿', rolling: release.status === 'paused' ? '已继续发布' : '已开始发布', paused: '已暂停', full: '已改为全量' }[status]}。`)
  } finally {
    busy.value = null
  }
}
async function remove(release: AppRelease) {
  if (busy.value) return
  const confirmed = await confirmAction({ title: `删除草稿 ${release.version}？`, ok: '删除', text: '草稿还没给任何人，删除后可以重新新建。' })
  if (!confirmed) return
  busy.value = release.version
  try {
    if (await runAction(() => request(`/api/v1/app-releases/${release.version}`, undefined, 'DELETE'))) await reload(`草稿 ${release.version} 已删除。`)
  } finally {
    busy.value = null
  }
}
function moreFor(release: AppRelease) {
  const to = (label: string, status: ReleaseStatus, danger = false) => ({ label, danger, run: () => void setStatus(release, status) })
  if (release.status === 'draft') return [to('开始发布', 'rolling'), 'divider' as const, { label: '删除', danger: true, run: () => void remove(release) }]
  if (release.status === 'rolling') return [to('暂停', 'paused', true), to('改为全量', 'full')]
  if (release.status === 'paused') return [to('继续发布', 'rolling'), to('改为全量', 'full')]
  return [to('暂停', 'paused', true)]
}
</script>

<template>
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
          empty-title="还没有灰度中的版本"
          empty-subtitle="在 GitHub 上把新版本发成预发布，再点「新建版本」。"
          @retry="load"
        >
          <template #head>
            <th scope="col">版本</th>
            <th scope="col">状态</th>
            <th scope="col">比例</th>
            <th scope="col">先发组织</th>
            <th scope="col">暂缓组织</th>
            <th scope="col" class="text-nowrap">已提供 / 已升级</th>
            <th scope="col" class="w-1"><span class="visually-hidden">操作</span></th>
          </template>
          <tr v-for="release in releases" :key="release.version" :aria-busy="busy === release.version || undefined">
            <td>
              <div class="fw-medium font-monospace">{{ release.version }}</div>
              <div v-if="release.note" class="text-secondary small text-break">{{ release.note }}</div>
            </td>
            <td><span :class="['badge', `bg-${STATUS[release.status].color}-lt`]" :title="STATUS[release.status].hint">{{ STATUS[release.status].name }}</span></td>
            <td class="text-nowrap">{{ reachText(release) }}</td>
            <td class="text-break">{{ orgNames(release.early) }}</td>
            <td class="text-break">{{ orgNames(release.hold) }}</td>
            <td class="text-nowrap">{{ release.offered }} / {{ release.upgraded }}</td>
            <td>
              <RowActions :name="release.version" :primary="{ label: '编辑', run: () => edit(release) }" :more="moreFor(release)" :disabled="busy === release.version" />
            </td>
          </tr>
          <template #footer>
            <div v-if="page.data.value" class="card-footer text-secondary">
              共 {{ releases.length }} 个版本。「已提供」= 正在运行该版本，或最近一次检查得到了它的安装；「已升级」= 正在运行它的安装；都只算最近 {{ installations.days }} 天检查过更新的。
            </div>
          </template>
        </ListCard>
      </section>
    </div>
  </div>

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
    <div class="form-hint">新建后是草稿，谁都看不到；设置好先发组织和比例后再开始发布。</div>
  </FormDialog>

  <FormDialog :open="form.open" id="release-dialog" kicker="编辑版本" :title="form.version" close-label="关闭版本编辑" :pending="form.pending" :error="form.error" scrollable @submit="saveEdit" @close="form.open = false">
    <div class="row g-3 mb-3">
      <div class="col-sm-6">
        <label class="form-label" for="release-status">状态</label>
        <select id="release-status" v-model="form.status" class="form-select">
          <option v-for="status in statusChoices" :key="status" :value="status">{{ STATUS[status].name }} · {{ STATUS[status].hint }}</option>
        </select>
      </div>
      <div class="col-sm-6">
        <label class="form-label" for="release-percent">比例（%）</label>
        <div class="d-flex align-items-center gap-2">
          <input v-model.number="form.percent" class="form-range flex-fill" type="range" min="0" max="100" step="1" :disabled="form.status === 'full'" aria-label="比例滑块" />
          <input id="release-percent" :value="form.status === 'full' ? 100 : form.percent" class="form-control percent-input" type="number" min="0" max="100" step="1" :disabled="form.status === 'full'"
            @input="form.percent = Number(($event.target as HTMLInputElement).value)" />
        </div>
      </div>
    </div>
    <div class="form-hint mb-3">先发组织不看比例；其他人按安装分组，比例内的才收到；用户手动检查更新时不看比例。暂缓组织始终收不到，手动检查也一样。</div>
    <div class="mb-3">
      <div class="d-flex align-items-center mb-2">
        <span class="form-label mb-0">组织</span>
        <span class="ms-auto text-secondary small placement-summary">{{ placementSummary }}</span>
      </div>
      <input v-model="form.search" class="form-control mb-2" type="search" placeholder="搜索组织名称或组织号" aria-label="搜索组织" />
      <div class="list-group grant-list">
        <div v-for="org in visibleOrgs" :key="org.id" class="list-group-item d-flex align-items-center gap-2">
          <span class="text-break">{{ org.name }} <span class="text-secondary">#{{ org.id }}</span></span>
          <span v-if="!org.enabled" class="badge bg-secondary-lt">已停用</span>
          <select v-model="form.placement[org.id]" class="form-select form-select-sm placement-select ms-auto" :aria-label="`${org.name} 的发布方式`">
            <option :value="undefined">按比例</option>
            <option value="early">先发</option>
            <option value="hold">暂缓</option>
          </select>
        </div>
        <div v-if="!visibleOrgs.length" class="list-group-item text-secondary">
          {{ organizations.length ? '没有匹配的组织，已选的仍保留。' : '还没有登记组织，先到「组织」页同步。' }}
        </div>
      </div>
    </div>
    <div>
      <label class="form-label" for="release-note">备注</label>
      <input id="release-note" v-model="form.note" class="form-control" maxlength="200" />
    </div>
    <template #footer>
      <span v-if="form.updatedAt" class="me-auto text-secondary small">上次修改 {{ formatTime(form.updatedAt) }}</span>
    </template>
  </FormDialog>
</template>
