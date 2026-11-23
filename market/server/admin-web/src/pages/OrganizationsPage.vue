<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef } from 'vue'
import { ApiError, request } from '../api'
import { notify, runAction } from '../feedback'
import { confirmAction } from '../confirm'
import { shell, useRefresh } from '../shell'
import { isPlatform, state } from '../session'
import { loadOrganizations, organizationLabel, type Organization } from '../directory'
import { loadPluginIndex, type PluginIndexEntry } from '../plugins'
import { ICONS, MY_ORGANIZATION, viewById } from '../views'
import AppIcon from '../components/AppIcon.vue'
import PageHeader from '../components/PageHeader.vue'
import ListCard from '../components/ListCard.vue'
import RowActions from '../components/RowActions.vue'
import FormDialog from '../components/FormDialog.vue'
import GrantsDialog from '../components/GrantsDialog.vue'

/**
 * The Organizations page, as at /admin/#organizations (market-organizations.js). The platform
 * administrator keeps the directory (sync, register, enable) and opens one organization to see what
 * its members are offered. An organization administrator lands straight on its own organization
 * (「我的组织」) and can only narrow its granted plugins: switch one off, or name the members who see
 * it (none named = every member).
 */
interface OrgPlugin {
  id: string
  displayName: string
  package: string
  source: string
  switchable: boolean
  enabled: boolean
  visible: boolean
  members: { id: number; name: string }[]
}
const view = viewById('organizations')!
const heading = computed(() => (isPlatform.value ? view : MY_ORGANIZATION))

// ── Directory (platform administrator) ─────────────────────────────────────
const items = ref<Organization[]>([])
const syncReady = ref(false)
const plugins = ref<PluginIndexEntry[]>([])
const loaded = ref(false)
const loading = ref(false)
const loadError = ref('')
const query = ref('')
const visible = computed(() => {
  const term = query.value.trim().toLowerCase()
  return items.value.filter((org) => `${org.name} ${org.id}`.toLowerCase().includes(term))
})
const label = (id: number) => organizationLabel(items.value, id)
const note = computed(() =>
  syncReady.value
    ? `共 ${items.value.length} 个组织。同步会从 TokensAPI 补齐新组织、更新名称，不会删除或停用已有组织。`
    : `共 ${items.value.length} 个组织。未配置 TokensAPI 组织名录，只能手动登记。`,
)

// ── One organization ───────────────────────────────────────────────────────
const detail = shallowRef<{ organization: Organization; items: OrgPlugin[] } | null>(null)
async function readDetail(id: number) {
  const [organization, list] = await Promise.all([request<Organization>(`/api/v1/organizations/${id}`), request<{ items: OrgPlugin[] }>(`/api/v1/organizations/${id}/plugins`)])
  detail.value = { organization, items: list.items }
}
const pluginPath = (plugin: OrgPlugin) => `/api/v1/organizations/${detail.value!.organization.id}/plugins/${encodeURIComponent(plugin.id)}`
const SOURCES: Record<string, string> = { public: '公开', organization: '组织授权' }
const reach = (plugin: OrgPlugin) =>
  !plugin.visible ? (plugin.enabled ? '不可见（组织已停用）' : '已关闭') : plugin.members.length ? `仅 ${plugin.members.length} 位成员可见` : '全员可见'

/**
 * The page's data: the directory (and, when one is open, that organization) for the platform; the
 * own organization alone for an organization administrator. Only the latest load is taken.
 */
let turn = 0
async function load() {
  const mine = ++turn
  loading.value = true
  loadError.value = ''
  try {
    if (!isPlatform.value) {
      await readDetail(state.session!.organizationId!)
    } else {
      const [list, index] = await Promise.all([loadOrganizations(), loadPluginIndex()])
      if (mine !== turn) return false
      items.value = list.items
      syncReady.value = list.syncReady
      plugins.value = index
      shell.counts.organizations = list.items.length
      if (detail.value) await readDetail(detail.value.organization.id)
    }
    if (mine !== turn) return false
    loaded.value = true
    shell.lastRefresh = Date.now()
    return true
  } catch (error) {
    if (mine === turn) loadError.value = error instanceof Error ? error.message : String(error)
    return false
  } finally {
    if (mine === turn) loading.value = false
  }
}
async function reload(message: string) {
  if (await load()) notify(message)
  else notify(`${message} 但页面刷新失败：${loadError.value} 请刷新核对，无需重复保存。`, 'error')
}
useRefresh(async () => {
  if (!(await load())) throw new Error(loadError.value || '刷新失败')
})
onMounted(load)

// ── Row actions ────────────────────────────────────────────────────────────
const busy = ref<string | null>(null)
async function withLock(key: string, fn: () => Promise<unknown>) {
  if (busy.value !== null) return
  busy.value = key
  try {
    await fn()
  } finally {
    busy.value = null
  }
}
const grants = ref<InstanceType<typeof GrantsDialog>>()
const openDetail = (org: Organization) => void withLock(`org:${org.id}`, () => runAction(() => readDetail(org.id)))
function toggleOrg(org: Organization) {
  void withLock(`org:${org.id}`, async () => {
    if (await runAction(() => request(`/api/v1/organizations/${org.id}`, { name: org.name, enabled: !org.enabled }))) await reload(`${org.name} 已${org.enabled ? '停用' : '启用'}。`)
  })
}
const orgMenu = (org: Organization) => [
  { label: '授权插件', run: () => void withLock(`org:${org.id}`, () => grants.value!.show(`/api/v1/organizations/${org.id}`, label(org.id))) },
  { label: '编辑', run: () => edit(org) },
  'divider' as const,
  { label: org.enabled ? '停用' : '启用', danger: org.enabled, run: () => toggleOrg(org) },
]
function togglePlugin(plugin: OrgPlugin) {
  void withLock(`plugin:${plugin.id}`, async () => {
    if (await runAction(() => request(pluginPath(plugin), { enabled: !plugin.enabled })))
      await reload(`${plugin.displayName} 已对本组织${plugin.enabled ? '关闭' : '开启'}。`)
  })
}
async function sync() {
  await withLock('sync', async () => {
    let count = 0
    if (await runAction(async () => ((count = (await request<{ count: number }>('/api/v1/organizations/sync', {}, 'POST')).count)))) await reload(`已同步 ${count} 个组织。`)
  })
}

// ── Register / edit ────────────────────────────────────────────────────────
const form = reactive({ open: false, editing: null as Organization | null, id: '' as string | number, name: '', enabled: true, pending: false, error: '' })
function edit(org: Organization | null = null) {
  Object.assign(form, { open: true, editing: org, id: org?.id ?? '', name: org?.name ?? '', enabled: org?.enabled ?? true, pending: false, error: '' })
}
const showError = (target: { error: string }) => (message: string, cause: unknown) => {
  if (!(cause instanceof ApiError && cause.status === 401)) target.error = message
}
async function save() {
  const id = Number(form.id)
  const name = form.name.trim()
  form.pending = true
  form.error = ''
  const ok = await runAction(() => request(`/api/v1/organizations/${id}`, { name, enabled: form.enabled }), { onError: showError(form) })
  form.pending = false
  if (!ok) return
  form.open = false
  await reload(form.editing ? '组织已保存。' : `${name} 已登记。`)
}

// ── Members of one granted plugin ──────────────────────────────────────────
interface Member {
  id: number
  name: string
  username?: string
}
const members = reactive({
  open: false, plugin: null as OrgPlugin | null, chosen: new Map<number, string>(), keyword: '', searching: false, found: null as Member[] | null, more: false, pending: false, error: '',
})
function editMembers(plugin: OrgPlugin) {
  Object.assign(members, { open: true, plugin, chosen: new Map(plugin.members.map((member) => [member.id, member.name])), keyword: '', searching: false, found: null, more: false, pending: false, error: '' })
}
async function searchMembers() {
  const keyword = members.keyword.trim()
  if (!keyword || members.searching || !detail.value) return
  members.searching = true
  members.error = ''
  await runAction(async () => {
    const found = await request<{ items: Member[]; more?: boolean }>(`/api/v1/organizations/${detail.value!.organization.id}/members?keyword=${encodeURIComponent(keyword)}`)
    members.found = found.items
    members.more = !!found.more
  }, { onError: showError(members) })
  members.searching = false
}
async function saveMembers() {
  const plugin = members.plugin!
  const ids = [...members.chosen.keys()]
  if (!ids.length && plugin.members.length && !(await confirmAction({
    title: `清空「${plugin.displayName}」的可见成员？`, ok: '清空并保存',
    text: `清空后 ${plugin.displayName} 对本组织全员可见，不再只限名单上的 ${plugin.members.length} 位成员；只影响本组织。`,
  }))) return
  members.pending = true
  members.error = ''
  const ok = await runAction(() => request(pluginPath(plugin), { members: ids }), { onError: showError(members) })
  members.pending = false
  if (!ok) return
  members.open = false
  await reload(ids.length ? `${plugin.displayName} 已指定 ${ids.length} 位成员可见。` : `${plugin.displayName} 已恢复本组织全员可见。`)
}
</script>

<template>
  <PageHeader :title="heading.title" :description="heading.description">
    <template v-if="isPlatform" #actions>
      <button class="btn" type="button" @click="edit()">手动登记</button>
      <button v-if="syncReady" :class="['btn', 'btn-primary', busy === 'sync' && 'btn-loading']" type="button" :disabled="busy === 'sync'" @click="sync">同步组织</button>
    </template>
  </PageHeader>
  <div class="page-body">
    <div class="container-fluid">
      <section aria-label="组织">
        <ListCard
          v-if="isPlatform && !detail"
          :loading="loading"
          :ready="loaded"
          :error="loadError"
          :count="visible.length"
          :empty-title="items.length ? '没有匹配的组织' : '暂无组织'"
          :empty-subtitle="items.length ? '' : '可同步 TokensAPI 名录或手动登记。'"
          @retry="load"
        >
          <template #toolbar>
            <div class="card-body border-bottom py-3">
              <div class="input-icon">
                <span class="input-icon-addon"><AppIcon :paths="ICONS.search" /></span>
                <input v-model="query" class="form-control" type="search" placeholder="搜索组织名称或 ID" aria-label="搜索组织名录" />
              </div>
            </div>
          </template>
          <template #head>
            <th scope="col">组织</th>
            <th scope="col">组织 ID</th>
            <th scope="col">组织授权</th>
            <th scope="col">状态</th>
            <th scope="col" class="w-1"><span class="visually-hidden">操作</span></th>
          </template>
          <tr v-for="org in visible" :key="org.id" :aria-busy="busy === `org:${org.id}` || undefined">
            <td>
              <div class="fw-medium text-break">{{ org.name }}</div>
              <div v-if="org.hidden" class="text-secondary small">组织管理员关闭了 {{ org.hidden }} 个插件</div>
            </td>
            <td class="font-monospace">{{ org.id }}</td>
            <td>{{ org.granted ? `${org.granted} 个插件` : '—' }}</td>
            <td><span :class="['badge', org.enabled ? 'bg-green-lt' : 'bg-secondary-lt']">{{ org.enabled ? '启用' : '已停用' }}</span></td>
            <td>
              <RowActions :name="org.name" :primary="{ label: '查看插件', run: () => openDetail(org) }" :more="orgMenu(org)" :disabled="busy !== null && busy !== `org:${org.id}`" :primary-busy="busy === `org:${org.id}`" />
            </td>
          </tr>
          <template #footer>
            <div v-if="loaded" class="card-footer text-secondary">{{ note }}</div>
          </template>
        </ListCard>

        <div v-else-if="detail" class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">{{ detail.organization.name }} (#{{ detail.organization.id }}){{ detail.organization.enabled ? '' : ' · 已停用' }}</h3>
              <p class="card-subtitle">公开插件对所有人可见，不受这里约束。平台授权给本组织的插件默认本组织全员可见，可在这里关闭，或指定只给哪些成员；只影响本组织。</p>
            </div>
            <div v-if="isPlatform" class="card-actions"><button class="btn" type="button" @click="detail = null">返回组织名录</button></div>
          </div>
          <div v-if="detail.items.length" class="table-responsive">
            <table class="table card-table table-vcenter">
              <thead>
                <tr>
                  <th scope="col">插件</th>
                  <th scope="col">来源</th>
                  <th scope="col">本组织成员</th>
                  <th scope="col" class="w-1"><span class="visually-hidden">操作</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="plugin in detail.items" :key="plugin.id" :aria-busy="busy === `plugin:${plugin.id}` || undefined">
                  <td>
                    <div class="fw-medium text-break">{{ plugin.displayName }}</div>
                    <div class="text-secondary small text-break">{{ plugin.package }}</div>
                  </td>
                  <td><span :class="['badge', plugin.source === 'public' ? 'bg-green-lt' : 'bg-yellow-lt']">{{ plugin.source === 'public' ? '公开' : SOURCES[plugin.source] || plugin.source }}</span></td>
                  <td :class="plugin.visible ? '' : 'text-secondary'">{{ reach(plugin) }}</td>
                  <td>
                    <RowActions
                      v-if="plugin.switchable"
                      :name="plugin.displayName"
                      :primary="{ label: '指定成员', run: () => editMembers(plugin) }"
                      :more="[{ label: plugin.enabled ? '对本组织关闭' : '对本组织开启', danger: plugin.enabled, run: () => togglePlugin(plugin) }]"
                      :busy="busy === `plugin:${plugin.id}`"
                    />
                    <span v-else class="text-secondary text-nowrap">所有人可见</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="empty"><p class="empty-title">暂无本组织可用的插件</p></div>
        </div>
        <div v-else-if="loadError" class="card">
          <div class="empty" role="alert">
            <p class="empty-title">加载失败</p>
            <p class="empty-subtitle text-secondary text-break">{{ loadError }}</p>
            <div class="empty-action"><button type="button" class="btn" @click="load">重试</button></div>
          </div>
        </div>
        <div v-else class="card"><div class="empty" role="status"><p class="empty-title text-secondary">正在加载…</p></div></div>
      </section>
    </div>
  </div>

  <FormDialog :open="form.open" id="org-dialog" :title="form.editing ? '编辑组织' : '登记组织'" close-label="关闭组织编辑" submit-label="保存组织" :pending="form.pending" :error="form.error" @submit="save" @close="form.open = false">
    <div class="mb-3">
      <label class="form-label" for="organization-id">TokensAPI 组织 ID</label>
      <input id="organization-id" v-model="form.id" class="form-control" type="number" min="1" max="9007199254740991" step="1" required :readonly="!!form.editing" />
      <div class="form-hint">组织 ID 保存后不可修改。</div>
    </div>
    <div class="mb-3">
      <label class="form-label" for="organization-name">组织名称</label>
      <input id="organization-name" v-model="form.name" class="form-control" maxlength="200" required />
    </div>
    <label class="form-check"><input v-model="form.enabled" class="form-check-input" type="checkbox" /><span class="form-check-label">启用此组织</span></label>
    <div class="form-hint">停用后该组织的组织授权全部暂停、其管理员无法登录；单独 Key 授权不受影响。</div>
  </FormDialog>

  <FormDialog :open="members.open" id="members" kicker="指定成员" :title="members.plugin?.displayName ?? ''" close-label="关闭指定成员" scrollable :pending="members.pending" :error="members.error" @submit="saveMembers" @close="members.open = false">
    <div class="alert alert-info">不指定成员时本组织全员可见；指定后只有名单里的成员可见。清空名单即恢复全员可见。</div>
    <label class="form-label" for="member-lookup">搜索本组织成员</label>
    <div class="input-group">
      <input id="member-lookup" v-model="members.keyword" class="form-control" type="search" maxlength="100" placeholder="用户名、显示名或用户 ID" @keydown.enter.prevent="searchMembers" />
      <button :class="['btn', members.searching && 'btn-loading']" type="button" :disabled="members.searching" @click="searchMembers">搜索</button>
    </div>
    <div class="btn-list mt-2">
      <button v-for="user in members.found ?? []" :key="user.id" class="btn btn-sm" type="button" @click="members.chosen.set(user.id, user.name)">
        + {{ user.name }}{{ user.username && user.username !== user.name ? ' · ' + user.username : '' }} (#{{ user.id }})
      </button>
      <p v-if="members.found && !members.found.length" class="text-secondary m-0">没有找到本组织的匹配成员。</p>
      <p v-if="members.more" class="text-secondary m-0">匹配的人较多，只查了前 100 个，可换更具体的关键词。</p>
    </div>
    <div class="form-label mt-3">可见成员（点击移除）</div>
    <div class="btn-list">
      <button v-for="[id, name] in [...members.chosen]" :key="id" class="btn btn-sm" type="button" @click="members.chosen.delete(id)">{{ name }} (#{{ id }}) ✕</button>
    </div>
    <template #footer>
      <span class="me-auto text-secondary">{{ members.chosen.size ? `只有这 ${members.chosen.size} 位成员可见` : '本组织全员可见' }}</span>
    </template>
  </FormDialog>

  <GrantsDialog ref="grants" :plugins="plugins" @saved="reload" />
</template>
