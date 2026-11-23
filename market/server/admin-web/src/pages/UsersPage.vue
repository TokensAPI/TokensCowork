<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ApiError, request } from '../api'
import { notify, runAction } from '../feedback'
import { confirmAction } from '../confirm'
import { shell, useRefresh } from '../shell'
import { useRequest } from '../useRequest'
import { loadUsers, userLabel, type MarketUser } from '../directory'
import { loadPluginIndex, pluginName, type PluginIndexEntry } from '../plugins'
import { ICONS, viewById } from '../views'
import AppIcon from '../components/AppIcon.vue'
import PageHeader from '../components/PageHeader.vue'
import ListCard from '../components/ListCard.vue'
import RowActions from '../components/RowActions.vue'
import FormDialog from '../components/FormDialog.vue'
import ModalDialog from '../components/ModalDialog.vue'
import GrantsDialog from '../components/GrantsDialog.vue'
import UserHoldings, { type UserAccess } from '../components/UserHoldings.vue'

/**
 * The Users page (#users): TokensAPI users the platform grants plugins
 * to one by one. A user grant follows the user to every Key they own. TokensAPI keeps the accounts;
 * the market only records the user number and the name shown here. Each listed user's effective
 * plugins are asked once per load and drawn in when they arrive, so a slow TokensAPI never holds up
 * the page.
 */
const view = viewById('users')!
const directory = useRequest(async () => {
  const [list, plugins] = await Promise.all([loadUsers(), loadPluginIndex()])
  return { users: list.items, searchReady: list.searchReady, plugins }
})
const users = computed(() => directory.data.value?.users ?? [])
const plugins = computed<PluginIndexEntry[]>(() => directory.data.value?.plugins ?? [])
const searchReady = computed(() => directory.data.value?.searchReady ?? false)
const query = ref('')
const visible = computed(() => {
  const term = query.value.trim().toLowerCase()
  return users.value.filter((user) => `${user.name} ${user.id}`.toLowerCase().includes(term))
})
const label = (id: number) => userLabel(users.value, id)
const note = computed(() =>
  searchReady.value
    ? `共 ${users.value.length} 个用户。添加时可从 TokensAPI 搜索。`
    : `共 ${users.value.length} 个用户。未配置 TokensAPI 用户搜索，添加时需手动填写用户 ID。`,
)

// Each user's restricted plugins with where they come from: { view } once read, { error } if not.
const access = reactive(new Map<number, { view?: UserAccess; error?: string }>())
function readAccess(list: MarketUser[]) {
  access.clear()
  for (const user of list)
    request<UserAccess>(`/api/v1/users/${user.id}/plugins`)
      .then((result) => access.set(user.id, { view: result }))
      .catch((error: unknown) => access.set(user.id, { error: error instanceof Error ? error.message : String(error) }))
}

async function load() {
  const ok = await directory.run()
  if (ok) {
    shell.counts.users = users.value.length
    shell.lastRefresh = Date.now()
    readAccess(users.value)
  }
  return ok
}
async function reload(message: string) {
  if (await load()) notify(message)
  else notify(`${message} 但页面刷新失败：${directory.error.value?.message ?? ''} 请刷新核对，无需重复保存。`, 'error')
}
useRefresh(async () => {
  if (!(await load())) throw directory.error.value ?? new Error('刷新失败')
})
onMounted(load)

// ── Add / rename ───────────────────────────────────────────────────────────
interface Found {
  id: number
  name: string
  username?: string
}
const form = reactive({ open: false, editing: null as MarketUser | null, id: '' as string | number, name: '', pending: false, error: '', keyword: '', searching: false, found: null as Found[] | null })
function edit(user: MarketUser | null = null) {
  Object.assign(form, { open: true, editing: user, id: user?.id ?? '', name: user?.name ?? '', pending: false, error: '', keyword: '', searching: false, found: null })
}
async function lookup() {
  const keyword = form.keyword.trim()
  if (!keyword || form.searching) return
  form.searching = true
  form.error = ''
  await runAction(async () => {
    form.found = (await request<{ items: Found[] }>(`/api/v1/users/search?keyword=${encodeURIComponent(keyword)}`)).items
  }, { onError: (message) => (form.error = message) })
  form.searching = false
}
function pick(user: Found) {
  form.id = user.id
  form.name = user.name
}
const grants = ref<InstanceType<typeof GrantsDialog>>()
async function save() {
  const id = Number(form.id)
  const name = form.name.trim()
  const adding = !form.editing
  form.pending = true
  form.error = ''
  const ok = await runAction(() => request(`/api/v1/users/${id}`, { name }), {
    onError: (message, cause) => {
      if (!(cause instanceof ApiError && cause.status === 401)) form.error = message
    },
  })
  form.pending = false
  if (!ok) return
  form.open = false
  await reload(adding ? `${name} 已添加。` : '名称已保存。')
  // A new user is added to be granted something; go straight there.
  if (adding && users.value.some((user) => user.id === id)) void grants.value?.show(`/api/v1/users/${id}`, label(id))
}

// ── Rows ───────────────────────────────────────────────────────────────────
const busy = ref<number | null>(null)
async function withRow(user: MarketUser, fn: () => Promise<unknown>) {
  if (busy.value !== null) return
  busy.value = user.id
  try {
    await fn()
  } finally {
    busy.value = null
  }
}
async function remove(user: MarketUser) {
  const held = user.plugins.length ? `它的 ${user.plugins.length} 项插件授权一并撤掉，对该用户名下所有 Key 生效。` : '它目前没有单独授权的插件。'
  if (!(await confirmAction({ title: `移除用户 ${label(user.id)}？`, ok: '移除用户', text: `${held}TokensAPI 里的账号、组织授权和单独登记的 Key 不受影响。` }))) return
  await withRow(user, async () => {
    if (await runAction(() => request(`/api/v1/users/${user.id}`, undefined, 'DELETE'))) await reload('用户已移除。')
  })
}
const moreFor = (user: MarketUser) => [{ label: '改名', run: () => edit(user) }, 'divider' as const, { label: '移除', danger: true, run: () => void remove(user) }]
const openGrants = (user: MarketUser) => void withRow(user, () => grants.value!.show(`/api/v1/users/${user.id}`, label(user.id)))

// ── Any user's effective plugins ───────────────────────────────────────────
// Any TokensAPI user by number, registered here or not: read-only, nothing is added to the list.
const lookupId = ref<string | number>('')
const lookupPending = ref(false)
const viewer = reactive({ open: false, view: null as UserAccess | null })
async function showAccess() {
  if (lookupPending.value) return
  lookupPending.value = true
  await runAction(async () => {
    viewer.view = await request<UserAccess>(`/api/v1/users/${Number(lookupId.value)}/plugins`)
    viewer.open = true
  })
  lookupPending.value = false
}
const orgText = computed(() => {
  const view = viewer.view
  if (!view) return ''
  const org = view.organization
  if (!org) return view.notice ? '未知' : '无'
  return `${org.name ? `${org.name} (#${org.id})` : `组织 #${org.id}`}${!org.registered ? ' · 市场未登记' : !org.enabled ? ' · 已停用' : ''}`
})
</script>

<template>
  <PageHeader :title="view.title" :description="view.description">
    <template #actions>
      <button class="btn btn-primary" type="button" @click="edit()"><AppIcon :paths="ICONS.plus" />添加用户</button>
    </template>
  </PageHeader>
  <div class="page-body">
    <div class="container-fluid">
      <section aria-label="用户">
        <ListCard
          :loading="directory.loading.value"
          :ready="!!directory.data.value"
          :error="directory.error.value?.message"
          :count="visible.length"
          :empty-title="users.length ? '没有匹配的用户' : '暂无用户'"
          :empty-subtitle="users.length ? '' : '添加后可单独给该用户授权插件，对其名下所有 Key 生效。'"
          @retry="load"
        >
          <template #toolbar>
            <div class="card-body border-bottom py-3 d-flex flex-wrap gap-2">
              <div class="input-icon flex-grow-1">
                <span class="input-icon-addon"><AppIcon :paths="ICONS.search" /></span>
                <input v-model="query" class="form-control" type="search" placeholder="搜索用户名称或 ID" aria-label="搜索用户名录" />
              </div>
              <form class="input-group w-auto" @submit.prevent="showAccess">
                <input v-model="lookupId" class="form-control" type="number" min="1" max="9007199254740991" step="1" required placeholder="任意用户 ID" aria-label="按用户 ID 查看授权" />
                <button :class="['btn', lookupPending && 'btn-loading']" type="submit" :disabled="lookupPending">查看授权</button>
              </form>
            </div>
          </template>
          <template #head>
            <th scope="col">用户</th>
            <th scope="col">用户 ID</th>
            <th scope="col">授权插件</th>
            <th scope="col" class="w-1"><span class="visually-hidden">操作</span></th>
          </template>
          <tr v-for="user in visible" :key="user.id" :aria-busy="busy === user.id || undefined">
            <td class="fw-medium text-break">{{ user.name }}</td>
            <td class="font-monospace">{{ user.id }}</td>
            <td class="text-break">
              <span v-if="!access.has(user.id)" class="text-secondary">正在读取…</span>
              <UserHoldings v-else-if="access.get(user.id)?.view" :view="access.get(user.id)!.view!" :plugins="plugins" />
              <template v-else>
                <div>{{ user.plugins.length ? user.plugins.map((id) => pluginName(plugins, id)).join('、') : '—' }}</div>
                <div class="text-danger small">实际授权读取失败：{{ access.get(user.id)?.error }}</div>
              </template>
            </td>
            <td><RowActions :name="label(user.id)" :primary="{ label: '授权插件', run: () => openGrants(user) }" :more="moreFor(user)" :disabled="busy === user.id" /></td>
          </tr>
          <template #footer>
            <div v-if="directory.data.value" class="card-footer text-secondary">{{ note }}</div>
          </template>
        </ListCard>
      </section>
    </div>
  </div>

  <FormDialog :open="form.open" id="user-dialog" :title="form.editing ? '修改名称' : '添加用户'" close-label="关闭用户编辑" :pending="form.pending" :error="form.error" error-class="" @submit="save" @close="form.open = false">
    <div v-if="!form.editing && searchReady" class="mb-3">
      <label class="form-label" for="user-lookup">在 TokensAPI 搜索</label>
      <div class="input-group">
        <input id="user-lookup" v-model="form.keyword" class="form-control" type="search" maxlength="100" placeholder="用户名或显示名" @keydown.enter.prevent="lookup" />
        <button :class="['btn', form.searching && 'btn-loading']" type="button" :disabled="form.searching" @click="lookup">搜索</button>
      </div>
      <div class="btn-list mt-2">
        <button v-for="user in form.found ?? []" :key="user.id" class="btn btn-sm" type="button" @click="pick(user)">
          {{ user.name }}{{ user.username && user.username !== user.name ? ' · ' + user.username : '' }} (#{{ user.id }})
        </button>
        <p v-if="form.found && !form.found.length" class="text-secondary m-0">没有找到匹配的用户。</p>
      </div>
    </div>
    <div class="mb-3">
      <label class="form-label" for="user-id">TokensAPI 用户 ID</label>
      <input id="user-id" v-model="form.id" class="form-control" type="number" min="1" max="9007199254740991" step="1" required :readonly="!!form.editing" />
    </div>
    <div class="mb-3">
      <label class="form-label" for="user-name">显示名称</label>
      <input id="user-name" v-model="form.name" class="form-control" maxlength="200" required />
      <div class="form-hint">只记用户 ID 和名称，账号本身在 TokensAPI。</div>
    </div>
  </FormDialog>

  <ModalDialog :open="viewer.open" labelledby="user-access-title" scrollable @close="viewer.open = false">
    <div v-if="viewer.view" class="modal-content">
      <div class="modal-header">
        <div class="min-w-0">
          <div class="text-secondary small">实际拥有的授权</div>
          <h2 id="user-access-title" class="modal-title text-break">{{ viewer.view.name }} (#{{ viewer.view.id }})</h2>
        </div>
        <button class="btn-close" type="button" aria-label="关闭用户授权" @click="viewer.open = false"></button>
      </div>
      <div class="modal-body">
        <dl class="row mb-3">
          <dt class="col-4">市场名录</dt>
          <dd class="col-8">{{ viewer.view.registered ? '已登记' : '未登记（只查看，不会登记）' }}</dd>
          <dt class="col-4">所属组织</dt>
          <dd class="col-8 text-break">{{ orgText }}</dd>
        </dl>
        <UserHoldings :view="viewer.view" :plugins="plugins" />
        <div class="form-hint mt-3">只列受限插件；公开插件所有人可见，按 Key 的单独授权不归属于用户，均不列出。</div>
      </div>
    </div>
  </ModalDialog>

  <GrantsDialog ref="grants" :plugins="plugins" @saved="reload" />
</template>
