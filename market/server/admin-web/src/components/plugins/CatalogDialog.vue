<script setup lang="ts">
import { computed, reactive } from 'vue'
import FormDialog from '../FormDialog.vue'
import { ApiError, request } from '../../api'
import { runAction } from '../../feedback'
import { confirmDiscard } from '../../confirm'
import { state as session } from '../../session'
import type { MarketPlugin } from '../../plugins'

/**
 * A plugin's metadata, as at /admin/ (market-catalog-editor.js): create a draft or edit one, filled
 * by hand or read from npm (「读取并自动填写」, with a README summary to adopt). An npm package
 * follows the registry's stable latest; a fixed Git commit is pinned. Closing it with changes asks
 * first (and so does leaving the page; see dirty()).
 */
const emit = defineEmits<{ saved: [message: string] }>()

const fields = () => ({ id: '', package: '', importVersion: '', name: '', summary: '', repository: '', version: '1.0.0', kind: 'npm', registry: 'npm', commit: '' })
const form = reactive({ open: false, editing: null as MarketPlugin | null, ...fields(), generatedId: '', readme: '', readmeNotice: '', baseline: '', pending: false, reading: false, error: '' })
const npm = computed(() => form.kind === 'npm')
const mode = computed(() => (npm.value ? 'latest' : 'pinned'))
const privateRegistry = computed(() => session.session?.environment?.privateRegistryReady === true)
const draft = () => JSON.stringify([form.id, form.package, form.name, form.summary, form.repository, form.version, form.kind, form.registry, form.commit])
const dirty = () => form.open && draft() !== form.baseline

function open(plugin: MarketPlugin | null = null) {
  Object.assign(form, fields(), {
    open: true, editing: plugin, generatedId: '', readme: '', readmeNotice: '', pending: false, reading: false, error: '',
    id: plugin?.id ?? '', package: plugin?.package ?? '', name: plugin?.displayName ?? '', summary: plugin?.summary ?? '', repository: plugin?.repository ?? '',
    version: plugin?.version ?? '1.0.0', kind: plugin?.npm === false ? 'github' : 'npm', registry: plugin?.registry ?? 'npm', commit: plugin?.installSource?.commit ?? '',
  })
  form.baseline = draft()
}
async function close() {
  if (form.pending || form.reading) return
  if (dirty() && !(await confirmDiscard())) return
  form.open = false
}
const onError = (message: string, cause: unknown) => {
  if (!(cause instanceof ApiError && cause.status === 401)) form.error = message
}

interface NpmLookup {
  package: string
  suggestedId: string
  version: string
  displayName: string
  summary: string
  readmeSummary?: string
  readmeNotice?: string
  repository: string
  prerelease?: boolean
  license?: string
}
async function readNpm() {
  if (form.reading || form.pending) return
  form.reading = true
  form.error = ''
  await runAction(async () => {
    const pkg = form.package.trim()
    if (!pkg) throw new Error('请先填写 npm 包名或粘贴 npm 链接')
    const data = await request<NpmLookup>(`/api/v1/npm-package?name=${encodeURIComponent(pkg)}&version=${encodeURIComponent(form.importVersion.trim() || 'latest')}&registry=${encodeURIComponent(form.registry)}`)
    form.package = data.package
    if (!form.editing && (!form.id.trim() || form.id === form.generatedId)) {
      form.generatedId = data.suggestedId
      form.id = data.suggestedId
    }
    Object.assign(form, { version: data.version, name: data.displayName, summary: data.summary, readme: data.readmeSummary || '', readmeNotice: data.readmeNotice || '', repository: data.repository, kind: 'npm' })
    form.error = '已读取，可核对资料后保存草稿。' +
      (data.prerelease ? '当前是预发布版本，桌面安装器暂不支持上架安装。' : '') +
      (data.license ? `npm 许可证：${data.license}。` : 'npm 未声明许可证。') +
      '上架前仍须完成完整生产依赖许可证检查。' +
      (data.readmeSummary ? '下方提供 README 简介建议，可点击采用。' : data.readmeNotice || '')
  }, { onError })
  form.reading = false
}

async function save() {
  const editing = form.editing
  const metadata = {
    id: form.id.trim(), package: form.package.trim(), displayName: form.name.trim(), summary: form.summary.trim(), repository: form.repository.trim(), version: form.version.trim(),
    npm: npm.value, ...(npm.value ? { registry: form.registry } : { installSource: { kind: 'github', commit: form.commit.trim() } }),
  }
  form.pending = true
  form.error = ''
  let state = ''
  const ok = await runAction(async () => {
    const result = editing
      ? await request<{ state?: string }>(`/api/v1/plugins/${encodeURIComponent(editing.id)}`, { revision: editing.revision, metadata }, 'PATCH')
      : await request<{ state?: string }>('/api/v1/plugins', { id: metadata.id, metadata }, 'POST')
    state = result.state ?? ''
  }, { onError })
  form.pending = false
  if (!ok) return
  form.open = false
  emit('saved', !editing
    ? '插件已保存为草稿，访问范围默认「受限」：上架后只有授权的组织、Key 或用户能看到。先在「访问范围」里授权，再点击上架。'
    : state === 'draft' ? '插件已保存为草稿。配置访问范围并完成检查后，再点击上架。' : '插件信息已保存。')
}
defineExpose({ open, dirty })
</script>

<template>
  <FormDialog
    :open="form.open"
    id="catalog"
    :title="form.editing ? '编辑插件' : '新建插件'"
    close-label="关闭插件资料"
    submit-label="保存插件"
    size="lg"
    scrollable
    error-class=""
    :pending="form.pending"
    :error="form.error"
    @submit="save"
    @close="close"
  >
    <div class="alert alert-info">新插件默认保存为草稿。已上架插件若更换包、仓库或版本，会退回草稿，需重新检查后上架；仅修改名称、简介即时生效。</div>
    <div class="mb-3">
      <label class="form-label" for="catalog-id">插件 ID</label>
      <input id="catalog-id" v-model="form.id" class="form-control" pattern="[a-z0-9][a-z0-9-]{0,79}" maxlength="80" required placeholder="例如 tokens-my-tool" :readonly="!!form.editing" />
      <div class="form-hint">从 npm 读取时自动填写，也可自定义；创建后不可修改。</div>
    </div>
    <div class="mb-3">
      <label class="form-label" for="catalog-package">npm 包名或链接</label>
      <input id="catalog-package" v-model="form.package" class="form-control" maxlength="512" required placeholder="粘贴 https://www.npmjs.com/package/包名 或输入包名" />
    </div>
    <div class="input-group mb-3">
      <input v-model="form.importVersion" class="form-control" aria-label="读取的 npm 版本" placeholder="latest 或指定版本" />
      <button :class="['btn', form.reading && 'btn-loading']" type="button" :disabled="form.reading" @click="readNpm">读取并自动填写</button>
    </div>
    <div class="mb-3">
      <label class="form-label" for="catalog-name">显示名称</label><input id="catalog-name" v-model="form.name" class="form-control" maxlength="120" required />
    </div>
    <div class="mb-3">
      <label class="form-label" for="catalog-summary">简介</label><textarea id="catalog-summary" v-model="form.summary" class="form-control" maxlength="1000" rows="3" required></textarea>
    </div>
    <div v-if="form.readme" class="alert alert-secondary">
      <strong>README 简介建议</strong>
      <p class="my-2">{{ form.readme }}</p>
      <div class="text-secondary small mb-2">{{ form.readmeNotice }}</div>
      <button class="btn btn-sm" type="button" @click="form.summary = form.readme">采用这段简介</button>
    </div>
    <div class="mb-3">
      <label class="form-label" for="catalog-repository">GitHub 仓库（npm 安装选填）</label>
      <input id="catalog-repository" v-model="form.repository" class="form-control" type="url" placeholder="https://github.com/组织/仓库" :required="!npm" />
    </div>
    <div class="row g-3 mb-3">
      <div class="col-sm-6">
        <label class="form-label" for="catalog-version">版本（支持 Beta 草稿）</label>
        <input id="catalog-version" v-model="form.version" class="form-control" maxlength="64" placeholder="例如 0.1.0-beta.1" required />
      </div>
      <div class="col-sm-6">
        <label class="form-label" for="catalog-kind">安装方式</label>
        <select id="catalog-kind" v-model="form.kind" class="form-select">
          <option value="npm">npm 包</option>
          <option value="github">固定 Git commit</option>
        </select>
      </div>
    </div>
    <div v-if="npm" class="mb-3">
      <label class="form-label" for="catalog-registry">npm 来源</label>
      <select id="catalog-registry" v-model="form.registry" class="form-select">
        <option value="npm">兼容来源（新版自建仓库 / 旧版公开 npm）</option>
        <option v-if="privateRegistry" value="tokenscowork">TokensCowork 自建 Registry（需服务器配置）</option>
      </select>
      <div class="form-hint">兼容来源保留旧版的公开 npm 安装方式；新版经市场从自建仓库下载。仅自建的新插件请选择自建 Registry。新插件统一使用 @tokensapi/包名：仓库限制直连，用户公开或受限由市场范围决定，无需改包名。公开 npm 历史包和第三方兜底规则下的包不受市场权限保护。</div>
    </div>
    <div v-else class="mb-3">
      <label class="form-label" for="catalog-commit">Git commit</label>
      <input id="catalog-commit" v-model="form.commit" class="form-control" pattern="[a-f0-9]{40}" maxlength="40" placeholder="完整的 40 位 commit" required />
    </div>
    <div class="mb-3">
      <label class="form-label" for="catalog-mode">版本策略</label>
      <select id="catalog-mode" class="form-select" :value="mode" disabled>
        <option value="pinned">固定 Git 版本</option>
        <option value="latest">自动跟随 npm 稳定版 latest</option>
      </select>
      <div class="form-hint">npm 插件首次上架后自动跟随所选 Registry 的稳定版 latest，不需要重复保存或上架。名称、简介与权限保持不变；下架和草稿不会自动上架。依赖许可证检查应在发布前完成。Registry 查询失败或 latest 为预发布版时，暂不向应用提供该条目。</div>
    </div>
    <template #footer>
      <span class="me-auto text-secondary">下一步：访问范围 → 上架</span>
    </template>
  </FormDialog>
</template>
