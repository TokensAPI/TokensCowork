<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { request } from '../api'
import { notify, runAction } from '../feedback'
import { confirmAction } from '../confirm'
import { formatTime, shell, useRefresh } from '../shell'
import { loadPluginIndex, type PluginIndexEntry } from '../plugins'
import { viewById } from '../views'
import PageHeader from '../components/PageHeader.vue'
import ListCard from '../components/ListCard.vue'
import RowActions from '../components/RowActions.vue'
import IconDialog from '../components/IconDialog.vue'
import { docTitle, imageFileName, imageReferences, replaceImageReferences } from '../../../admin/assets/market-docs-admin.js'

/**
 * The plugin documentation page, as at /admin/#docs (market-docs-admin.js): pick a plugin, upload
 * Markdown files written elsewhere -- with the images they use, whose relative paths are pointed at
 * the uploaded addresses (T0102) -- replace or delete them, edit the plugin's icon, and open the docs
 * center as the administrator (/docs?admin). No editor on purpose. Readers see the pages at /docs,
 * limited to the plugins they may use.
 */
interface PluginDoc {
  id: number
  title: string
  body: string
  position: number
  updatedAt: number
}
const MAX_LENGTH = 200_000
/** Largest image the market accepts (services/doc-images.js MAX_DOC_IMAGE_BYTES). */
const MAX_IMAGE_BYTES = 1000 * 1024
const IMAGE_FILE = /\.(png|jpe?g|webp)$/iu
const view = viewById('docs')!

const plugins = ref<PluginIndexEntry[]>([])
const pluginId = ref('')
const docs = shallowRef<PluginDoc[]>([])
const loading = ref(false)
const loaded = ref(false)
const loadError = ref('')
const iconStamp = ref(Date.now())
const iconShown = ref(false)
const documentable = computed(() => plugins.value.filter((plugin) => plugin.category !== 'builtin' && plugin.state !== 'deleted'))
const iconSrc = computed(() => (pluginId.value ? `/v1/icons/${encodeURIComponent(pluginId.value)}?t=${iconStamp.value}` : ''))

let turn = 0
async function loadDocs() {
  const mine = ++turn
  const id = pluginId.value
  const items = id ? (await request<{ items: PluginDoc[] }>(`/api/v1/plugins/${id}/docs`)).items : []
  if (mine !== turn) return
  docs.value = items
  iconShown.value = false
  iconStamp.value = Date.now()
}
/** The plugin list (keeping the chosen plugin when it is still there), then its pages. */
async function load() {
  loading.value = true
  loadError.value = ''
  try {
    plugins.value = await loadPluginIndex()
    if (!documentable.value.some((plugin) => plugin.id === pluginId.value)) pluginId.value = documentable.value[0]?.id ?? ''
    await loadDocs()
    loaded.value = true
    shell.lastRefresh = Date.now()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    loading.value = false
  }
}
useRefresh(load)
onMounted(() => void runAction(load))
const choose = () => void runAction(loadDocs)

// ── Upload and replace ─────────────────────────────────────────────────────
// One hidden file input serves both uploading a new page and replacing one. Together with the page
// the administrator may pick the images it uses; anything it points at that was not picked is named
// before uploading, and the page is saved only after every picked image is in.
const file = ref<HTMLInputElement>()
const uploading = ref(false)
let pending: { replace?: PluginDoc } | null = null
function pick(target: { replace?: PluginDoc }) {
  if (!file.value) return
  pending = target
  file.value.value = ''
  file.value.click()
}
async function uploadImage(picture: File) {
  const response = await fetch(`/api/v1/plugins/${encodeURIComponent(pluginId.value)}/docs/images?name=${encodeURIComponent(picture.name)}`, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/octet-stream' }, body: picture,
  })
  const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string }
  if (!response.ok) throw new Error(`图片「${picture.name}」：${data.error || '上传失败，请稍后重试。'}`)
  return data.url!
}
const refuse = (message: string) => notify(message, 'error')
async function picked() {
  const files = [...(file.value?.files ?? [])]
  const target = pending
  pending = null
  if (!files.length || !pluginId.value) return
  const pictures = files.filter((item) => IMAGE_FILE.test(item.name))
  const pages = files.filter((item) => !IMAGE_FILE.test(item.name))
  if (pages.length !== 1) return refuse(pages.length ? '一次只能上传一篇文档，图片可以多张。' : '请同时选上要上传的 Markdown 文件。')
  const page = pages[0]!
  const names = new Map<string, File>()
  for (const picture of pictures) {
    if (picture.size > MAX_IMAGE_BYTES) return refuse(`图片「${picture.name}」超过 ${MAX_IMAGE_BYTES / 1024} KB，请压缩后再上传。`)
    const name = imageFileName(picture.name)
    if (names.has(name)) return refuse(`选了两张同名的图片「${picture.name}」，请改名后再上传。`)
    names.set(name, picture)
  }
  const text = await page.text()
  if (!text.trim()) return refuse('文件是空的。')
  if (text.length > MAX_LENGTH) return refuse(`文档超过 ${MAX_LENGTH} 字，请拆成多篇。`)
  const missing = (imageReferences(text) as { target: string; name: string }[]).filter((ref) => !names.has(ref.name))
  if (missing.length && !(await confirmAction({
    title: `正文引用的 ${missing.length} 张图片没有选`, ok: '仍然上传', danger: false,
    text: `${missing.slice(0, 10).map((ref) => ref.target).join('、')}${missing.length > 10 ? ` 等 ${missing.length} 张` : ''}。这些图片在文档中心只会显示成文字。可以取消后连同图片一起重新选择。`,
  }))) return
  const id = pluginId.value
  uploading.value = true
  await runAction(async () => {
    const uploaded = new Map<string, string>()
    for (const [name, picture] of names) uploaded.set(name, await uploadImage(picture))
    const body = replaceImageReferences(text, uploaded) as string
    if (body.length > MAX_LENGTH) throw new Error(`文档超过 ${MAX_LENGTH} 字，请拆成多篇。`)
    const title = docTitle(text, page.name) as string
    if (target?.replace) {
      await request(`/api/v1/plugins/${id}/docs/${target.replace.id}`, { title, body, position: target.replace.position }, 'PUT')
    } else {
      const position = docs.value.reduce((max, doc) => Math.max(max, doc.position + 1), 0)
      await request(`/api/v1/plugins/${id}/docs`, { title, body, position: Math.min(position, 10_000) }, 'POST')
    }
    await loadDocs()
  }, { success: `${target?.replace ? '文档已替换' : '文档已上传'}${names.size ? `，含 ${names.size} 张图片` : ''}。` })
  uploading.value = false
}

// ── Rows ───────────────────────────────────────────────────────────────────
const busy = ref<number | null>(null)
async function remove(doc: PluginDoc) {
  if (!(await confirmAction({ title: `删除文档「${doc.title}」？`, ok: '删除文档', text: '删除后用户在文档中心再也看不到这篇文档，不可恢复；这个插件的其他文档和图标不受影响。' }))) return
  busy.value = doc.id
  await runAction(async () => {
    await request(`/api/v1/plugins/${pluginId.value}/docs/${doc.id}`, undefined, 'DELETE')
    await loadDocs()
  }, { success: '文档已删除。' })
  busy.value = null
}

// ── Icon and docs center ───────────────────────────────────────────────────
// The preview reads the public address; a plugin without an icon answers 404 and the preview hides.
// Changing it opens the same icon dialog as the plugin page: one editor for one image.
const icons = ref<InstanceType<typeof IconDialog>>()
function editIcon() {
  const plugin = plugins.value.find((item) => item.id === pluginId.value)
  if (plugin) icons.value?.open(plugin)
}
async function iconSaved(message: string) {
  try {
    await load()
    notify(message)
  } catch (error) {
    notify(`${message} 但页面刷新失败：${error instanceof Error ? error.message : String(error)} 请刷新核对，无需重复保存。`, 'error')
  }
}
// The docs center reads this console session as the administrator and shows every plugin.
const openCenter = () => window.open(`/docs?admin#/${pluginId.value ? encodeURIComponent(pluginId.value) : ''}`, '_blank', 'noopener')
</script>

<template>
  <PageHeader :title="view.title" :description="view.description">
    <template #actions>
      <button class="btn" type="button" @click="openCenter">打开文档中心</button>
      <button :class="['btn', 'btn-primary', uploading && 'btn-loading']" type="button" :disabled="!pluginId || uploading" @click="pick({})">上传 Markdown</button>
    </template>
  </PageHeader>
  <div class="page-body">
    <div class="container-fluid">
      <section aria-label="插件文档">
        <ListCard :loading="loading" :ready="loaded" :error="loadError" :count="pluginId ? docs.length : 0" :empty-title="pluginId ? '这个插件还没有文档' : '没有可写文档的插件'" :empty-subtitle="pluginId ? '点右上角「上传 Markdown」添加。' : ''" @retry="() => runAction(load)">
          <template #toolbar>
            <div class="card-body border-bottom py-3">
              <div class="row g-2 align-items-center">
                <div class="col-12 col-md">
                  <select v-model="pluginId" class="form-select" aria-label="选择插件" @change="choose">
                    <option v-for="plugin in documentable" :key="plugin.id" :value="plugin.id">{{ plugin.displayName || plugin.id }}（{{ plugin.id }}）</option>
                  </select>
                </div>
                <div class="col-auto">
                  <span class="avatar rounded" aria-hidden="true"><img v-if="iconSrc" v-show="iconShown" :src="iconSrc" alt="" @load="iconShown = true" @error="iconShown = false" /></span>
                </div>
                <div class="col">
                  <button class="btn" type="button" :disabled="!pluginId" @click="editIcon">编辑图标</button>
                </div>
              </div>
              <input ref="file" type="file" multiple accept=".md,.markdown,.txt,text/markdown,text/plain,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" hidden @change="picked" />
              <p class="form-hint mb-0 mt-2">
                插件图标会显示在 TokensCowork 插件市场的卡片和文档中心里。文档上传在别处写好的 Markdown 文件（.md），每个插件可以有多篇；标题取文件里第一个一级标题，没有就用文件名。用户在文档中心（/docs）用自己的 TokensAPI Key 登录，只看到有权限的插件；「打开文档中心」以管理员身份查看全部插件。
              </p>
              <p class="form-hint mb-0 mt-1">
                带图片的文档：选文件时把 .md 和它引用的图片（PNG、JPEG、WebP，单张不超过 1000 KB）一起选上，正文里的相对路径（如 <code>images/step-1.png</code>）会按文件名换成上传后的地址。图片和文档一样只给有权限的人看。
              </p>
            </div>
          </template>
          <template #head>
            <th scope="col">标题</th>
            <th scope="col">排序</th>
            <th scope="col">长度</th>
            <th scope="col">更新于</th>
            <th scope="col" class="w-1"><span class="visually-hidden">操作</span></th>
          </template>
          <tr v-for="doc in docs" :key="doc.id" :aria-busy="busy === doc.id || undefined">
            <td class="fw-medium text-break">{{ doc.title }}</td>
            <td>{{ doc.position }}</td>
            <td>{{ doc.body.length }} 字</td>
            <td class="text-secondary text-nowrap">{{ formatTime(doc.updatedAt) }}</td>
            <td>
              <RowActions :name="doc.title" :primary="{ label: '替换', run: () => pick({ replace: doc }) }" :more="[{ label: '删除', danger: true, run: () => void remove(doc) }]" :disabled="busy === doc.id || uploading" />
            </td>
          </tr>
        </ListCard>
      </section>
    </div>
  </div>
  <IconDialog ref="icons" @saved="iconSaved" />
</template>
