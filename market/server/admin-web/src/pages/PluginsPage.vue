<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { request } from '../api'
import { notify, runAction } from '../feedback'
import { shell, useRefresh } from '../shell'
import { loadKeys, loadOrganizations, loadUsers, organizationLabel, userLabel, type MarketUser, type Organization } from '../directory'
import { STATES, type MarketPlugin, type PluginCounts } from '../plugins'
import { ICONS, viewById } from '../views'
import type { MarketKey } from './KeysPage.vue'
import AppIcon from '../components/AppIcon.vue'
import PageHeader from '../components/PageHeader.vue'
import DataPager from '../components/DataPager.vue'
import RowActions, { type RowAction } from '../components/RowActions.vue'
import IconDialog from '../components/IconDialog.vue'
import PluginAvatar from '../components/plugins/PluginAvatar.vue'
import AccessDialog from '../components/plugins/AccessDialog.vue'
import CatalogDialog from '../components/plugins/CatalogDialog.vue'
import LifecycleDialog, { type Operation } from '../components/plugins/LifecycleDialog.vue'

/**
 * The plugin page, as at /admin/#plugins (market-plugins.js): status tabs with their counts, the
 * filter bar (search, type, scope, reset), one server page shown as a table (default) or as cards,
 * and the pager. 「全部」 holds the product's built-in components (read-only) as well as the market's
 * own plugins, so 全部 = 内置 + 已上架 + 草稿 + 已下架. Editing the metadata, the access scope, the
 * icon and the state each has its dialog. Only the latest list asked for is shown.
 */
const VIEW_KEY = 'tokenscowork-market-plugin-view'
const view = viewById('plugins')!
const STAGES = [['all', '全部'], ['published', '已上架'], ['draft', '草稿'], ['archived', '已下架'], ['deleted', '回收站']] as const

// The table/cards choice is a per-browser convenience: storage may be blocked, and then it is not kept.
function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'table'
  } catch {
    return 'table'
  }
}
const layout = ref<'table' | 'cards'>(savedView())
function setLayout(next: 'table' | 'cards') {
  layout.value = next
  try {
    localStorage.setItem(VIEW_KEY, next)
  } catch {}
}

// ── Filters and the page ───────────────────────────────────────────────────
const stage = ref<string>('all')
const search = ref('')
const kind = ref('all')
const visibility = ref('all')
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)
const counts = ref<PluginCounts | null>(null)
const items = shallowRef<MarketPlugin[]>([])
const organizations = ref<Organization[]>([])
const keys = ref<MarketKey[]>([])
const users = ref<MarketUser[]>([])
const loading = ref(false)
const loaded = ref(false)
let turn = 0

const filters = () => {
  const q = search.value.trim()
  return { stage: stage.value, ...(kind.value !== 'all' ? { kind: kind.value } : {}), ...(visibility.value !== 'all' ? { visibility: visibility.value } : {}), ...(q ? { q } : {}) }
}
/** One page from the server. A slower answer to an older query never overwrites a newer one. */
async function loadList() {
  const mine = ++turn
  loading.value = true
  try {
    const result = await request<{ items: MarketPlugin[]; total: number; counts: PluginCounts; page: number; pageSize: number }>(
      '/api/v1/plugins?' + new URLSearchParams({ ...filters(), page: String(page.value), pageSize: String(pageSize.value) }),
    )
    if (mine !== turn) return
    items.value = result.items
    total.value = result.total
    counts.value = result.counts
    // The server answers a page past the end with the last page; follow it.
    page.value = result.page
    pageSize.value = result.pageSize
    loaded.value = true
    shell.counts.plugins = result.counts.all
    shell.lastRefresh = Date.now()
  } finally {
    if (mine === turn) loading.value = false
  }
}
/** The directories the scope column and the access dialog name, then the page. */
async function load() {
  const [orgs, keyList, userList] = await Promise.all([loadOrganizations(), loadKeys(), loadUsers()])
  organizations.value = orgs.items
  keys.value = keyList.items
  users.value = userList.items
  await loadList()
}
async function reload(message: string) {
  try {
    await load()
    notify(message)
  } catch (error) {
    notify(`${message} 但页面刷新失败：${error instanceof Error ? error.message : String(error)} 请刷新核对，无需重复保存。`, 'error')
  }
}
const read = (fn: () => Promise<unknown>) => runAction(fn)
// Every filter change starts again from page 1; paging keeps the filters.
function refilter() {
  page.value = 1
  void read(loadList)
}
function setStage(next: string) {
  if (next === stage.value) return
  stage.value = next
  refilter()
}
// Typing searches on the server after a short pause.
let searchTimer: ReturnType<typeof setTimeout> | undefined
function onSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    void read(loadList)
  }, 300)
}
function reset() {
  clearTimeout(searchTimer)
  stage.value = 'all'
  search.value = ''
  kind.value = 'all'
  visibility.value = 'all'
  refilter()
}
const go = (target: number) => {
  page.value = target
  void read(loadList)
}
const setPageSize = (size: number) => {
  pageSize.value = size
  refilter()
}
const kindNames = computed(() => ({ all: '全部类型', market: counts.value ? `市场插件 (${counts.value.market})` : '市场插件', builtin: counts.value ? `内置组件 (${counts.value.builtin})` : '内置组件' }))

// ── Cells ──────────────────────────────────────────────────────────────────
const builtin = (p: MarketPlugin) => p.category === 'builtin'
const restricted = (p: MarketPlugin) => !builtin(p) && p.visibility === 'restricted'
const stateOf = (p: MarketPlugin) => STATES[p.state] ?? STATES.draft!
const versionText = (p: MarketPlugin) => 'v' + (p.npm && p.state === 'published' ? p.npmLatestVersion || 'npm 暂无可用稳定版' : p.version)
const versionNote = (p: MarketPlugin) => (builtin(p) ? `产品 ${p.productVersion} 内置` : p.npm ? '自动跟随 npm latest' : '固定版本')
const scopeTitle = (p: MarketPlugin) =>
  restricted(p) ? [...(p.access?.organizations ?? []).map((id) => organizationLabel(organizations.value, id)), ...(p.access?.users ?? []).map((id) => userLabel(users.value, id))].join('、') : undefined
const disabledOrgs = (p: MarketPlugin) => (p.access?.organizations ?? []).filter((id) => !organizations.value.find((org) => org.id === id)?.enabled).length

// ── Actions ────────────────────────────────────────────────────────────────
const catalog = ref<InstanceType<typeof CatalogDialog>>()
const access = ref<InstanceType<typeof AccessDialog>>()
const icons = ref<InstanceType<typeof IconDialog>>()
const lifecycle = ref<InstanceType<typeof LifecycleDialog>>()
const transition = (p: MarketPlugin, operation: Operation) => () => lifecycle.value!.open(p, operation, !restricted(p))
function primaryFor(p: MarketPlugin): RowAction {
  return p.state === 'deleted' ? { label: '恢复草稿', run: transition(p, 'restore') } : { label: '编辑资料', run: () => catalog.value!.open(p) }
}
function moreFor(p: MarketPlugin): (RowAction | 'divider')[] {
  if (p.state === 'deleted') return [{ label: '彻底删除', run: transition(p, 'purge'), danger: true }]
  const lifecycleItems = p.state === 'published'
    ? [{ label: '下架', run: transition(p, 'archive') }]
    : [{ label: '上架', run: transition(p, 'publish') }, { label: '移入回收站', run: transition(p, 'trash'), danger: true }]
  return [{ label: '访问范围', run: () => access.value!.open(p) }, { label: '图标', run: () => icons.value!.open(p) }, 'divider', ...lifecycleItems]
}

// Leaving the page with unsaved edits in a dialog asks first.
function beforeUnload(event: BeforeUnloadEvent) {
  if (access.value?.dirty() || catalog.value?.dirty()) {
    event.preventDefault()
    event.returnValue = ''
  }
}
useRefresh(load)
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  void read(load)
})
onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <PageHeader :title="view.title" :description="view.description">
    <template #actions>
      <button class="btn btn-primary" type="button" @click="catalog!.open()"><AppIcon :paths="ICONS.plus" />新建插件</button>
    </template>
  </PageHeader>
  <div class="page-body">
    <div class="container-fluid">
      <section aria-label="插件">
        <div class="card">
          <div class="card-header flex-wrap gap-2">
            <ul class="nav nav-tabs card-header-tabs" aria-label="插件状态">
              <li v-for="[id, name] in STAGES" :key="id" class="nav-item">
                <button :class="['nav-link', stage === id && 'active']" type="button" :aria-current="stage === id ? 'true' : undefined" @click="setStage(id)">
                  {{ name }}<span class="badge ms-2">{{ counts ? counts[id] : '—' }}</span>
                </button>
              </li>
            </ul>
            <div class="card-actions btn-group" role="group" aria-label="列表视图">
              <button :class="['btn', 'btn-sm', layout === 'table' && 'active']" type="button" :aria-pressed="layout === 'table'" @click="setLayout('table')"><AppIcon :paths="ICONS.table" />表格</button>
              <button :class="['btn', 'btn-sm', layout === 'cards' && 'active']" type="button" :aria-pressed="layout === 'cards'" @click="setLayout('cards')"><AppIcon :paths="ICONS.cards" />卡片</button>
            </div>
          </div>
          <div class="card-body border-bottom py-3">
            <div class="row g-2 align-items-center">
              <div class="col-12 col-md">
                <div class="input-icon">
                  <span class="input-icon-addon"><AppIcon :paths="ICONS.search" /></span>
                  <input v-model="search" class="form-control" type="search" placeholder="搜索名称、包名、ID 或简介" aria-label="搜索插件" @input="onSearch" />
                </div>
              </div>
              <div class="col-6 col-md-auto">
                <select v-model="kind" class="form-select" aria-label="插件类型" @change="refilter">
                  <option value="all">{{ kindNames.all }}</option>
                  <option value="market">{{ kindNames.market }}</option>
                  <option value="builtin">{{ kindNames.builtin }}</option>
                </select>
              </div>
              <div class="col-6 col-md-auto">
                <select v-model="visibility" class="form-select" aria-label="访问范围" @change="refilter">
                  <option value="all">全部访问范围</option>
                  <option value="public">公开</option>
                  <option value="restricted">受限</option>
                </select>
              </div>
              <div class="col-12 col-md-auto">
                <button class="btn w-100" type="button" @click="reset">重置</button>
              </div>
            </div>
          </div>
          <div v-if="loading && loaded" class="progress progress-sm rounded-0 list-loading" aria-hidden="true"><div class="progress-bar progress-bar-indeterminate"></div></div>
          <div v-if="layout === 'table' && items.length" class="table-responsive" :aria-busy="loading || undefined">
            <table class="table card-table table-vcenter">
              <thead>
                <tr>
                  <th scope="col">插件</th>
                  <th scope="col">版本</th>
                  <th scope="col">状态</th>
                  <th scope="col">访问范围</th>
                  <th scope="col" class="w-1"><span class="visually-hidden">操作</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in items" :key="p.id">
                  <td>
                    <div class="d-flex align-items-center gap-2 min-w-0">
                      <PluginAvatar :name="p.displayName" :icon="p.icon" />
                      <div class="min-w-0">
                        <div class="fw-medium text-break">{{ p.displayName }}</div>
                        <div class="text-secondary small text-break">{{ p.package }}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div>
                      <div>{{ versionText(p) }}</div>
                      <div class="text-secondary small">{{ versionNote(p) }}</div>
                    </div>
                  </td>
                  <td><span :class="['badge', `bg-${stateOf(p)[1]}-lt`]">{{ stateOf(p)[0] }}</span></td>
                  <td>
                    <div :title="scopeTitle(p)">
                      <template v-if="builtin(p)"><span class="badge bg-azure-lt">所有人</span><div class="text-secondary small">随应用安装，不可卸载</div></template>
                      <template v-else-if="!restricted(p)"><span class="badge bg-green-lt">公开</span><div class="text-secondary small">{{ p.state === 'published' ? '所有人可见' : '上架后所有人可见' }}</div></template>
                      <template v-else>
                        <span class="badge bg-yellow-lt">受限</span>
                        <div class="text-secondary small">{{ p.access?.organizations.length ?? 0 }} 个组织 · {{ p.access?.keys.length ?? 0 }} 个 Key · {{ p.access?.users.length ?? 0 }} 个用户</div>
                        <div v-if="disabledOrgs(p)" class="text-warning small">{{ disabledOrgs(p) }} 个组织已停用</div>
                      </template>
                    </div>
                  </td>
                  <td>
                    <span v-if="builtin(p)" class="text-secondary small text-nowrap">由产品清单管理</span>
                    <RowActions v-else :name="p.displayName" :primary="primaryFor(p)" :more="moreFor(p)" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="layout === 'cards' && items.length" class="card-body plugin-cards">
            <div v-for="p in items" :key="p.id" class="card card-sm">
              <div class="card-body">
                <div class="d-flex align-items-start gap-2 mb-2">
                  <PluginAvatar :name="p.displayName" :icon="p.icon" />
                  <div class="min-w-0 flex-fill">
                    <div class="fw-medium text-break">{{ p.displayName }}</div>
                    <div class="text-secondary small text-break">{{ p.package }}</div>
                  </div>
                  <span :class="['badge', `bg-${stateOf(p)[1]}-lt`]">{{ stateOf(p)[0] }}</span>
                </div>
                <p class="text-secondary small plugin-summary" :title="p.summary || undefined">{{ p.summary || '—' }}</p>
                <div :title="scopeTitle(p)">
                  <template v-if="builtin(p)"><span class="badge bg-azure-lt">所有人</span><div class="text-secondary small">随应用安装，不可卸载</div></template>
                  <template v-else-if="!restricted(p)"><span class="badge bg-green-lt">公开</span><div class="text-secondary small">{{ p.state === 'published' ? '所有人可见' : '上架后所有人可见' }}</div></template>
                  <template v-else>
                    <span class="badge bg-yellow-lt">受限</span>
                    <div class="text-secondary small">{{ p.access?.organizations.length ?? 0 }} 个组织 · {{ p.access?.keys.length ?? 0 }} 个 Key · {{ p.access?.users.length ?? 0 }} 个用户</div>
                    <div v-if="disabledOrgs(p)" class="text-warning small">{{ disabledOrgs(p) }} 个组织已停用</div>
                  </template>
                </div>
              </div>
              <div class="card-footer d-flex align-items-center flex-wrap gap-2">
                <div class="me-auto small">
                  <div>{{ versionText(p) }}</div>
                  <div class="text-secondary small">{{ versionNote(p) }}</div>
                </div>
                <span v-if="builtin(p)" class="text-secondary small text-nowrap">由产品清单管理</span>
                <RowActions v-else :name="p.displayName" :primary="primaryFor(p)" :more="moreFor(p)" />
              </div>
            </div>
          </div>
          <div v-if="loaded && !items.length" class="empty">
            <p class="empty-title">没有匹配的插件</p>
            <p class="empty-subtitle text-secondary">换个关键词，或重置筛选条件。</p>
          </div>
          <div v-else-if="!loaded && loading" class="empty" role="status"><p class="empty-title text-secondary">正在加载…</p></div>
          <DataPager :page="page" :page-size="pageSize" :total="total" label="插件列表分页" size-label="每页插件数" @go="go" @size="setPageSize" />
        </div>
      </section>
    </div>
  </div>

  <CatalogDialog ref="catalog" @saved="reload" />
  <AccessDialog ref="access" :organizations="organizations" :keys="keys" :users="users" @saved="reload" />
  <IconDialog ref="icons" @saved="reload" />
  <LifecycleDialog ref="lifecycle" @saved="reload" />
</template>
