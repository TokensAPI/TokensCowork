/**
 * Reads the deployed market's directory into a local snapshot file, so local QA can run against
 * the real inventory instead of fixtures. Read-only GETs and a file write: nothing is ever sent to
 * production, and the snapshot carries no credential — API keys live there only as the
 * irreversible fingerprints the market itself stores.
 *
 *   node ops/market-pull.mjs [输出路径]
 * 写到默认路径后，npm --prefix market/server run dev 会自动用它；改到别处就用
 * MARKET_DEV_SNAPSHOT=<输出路径> 指过去。
 *
 * The credential is the platform administrator one, read from MARKET_DEV_PRODUCTION_ADMIN_TOKEN
 * (market/.market-dev.env is loaded for it, and that file is git-ignored).
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
try { process.loadEnvFile(resolve(root, '../.market-dev.env')) }
catch (error) { if (error.code !== 'ENOENT') throw error }

const ORIGIN = process.env.MARKET_DEV_PRODUCTION_ORIGIN || 'https://market.tokensapi.ai'
const TOKEN = process.env.MARKET_DEV_PRODUCTION_ADMIN_TOKEN
const OUTPUT = resolve(process.argv[2] ?? resolve(root, '../.market-production-snapshot.json'))

if (!TOKEN) {
  console.error('缺少 MARKET_DEV_PRODUCTION_ADMIN_TOKEN（平台管理凭证）。把它写进 market/.market-dev.env，该文件已被 git 忽略。')
  process.exit(1)
}
// A bare HTTPS origin only: a credential must never be sent to an arbitrary destination, and
// certainly not over plain HTTP.
const origin = new URL(ORIGIN)
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') {
  console.error('MARKET_DEV_PRODUCTION_ORIGIN 必须是不带凭据的裸 HTTPS 源，例如 https://market.tokensapi.ai')
  process.exit(1)
}

async function read(path) {
  const response = await fetch(new URL(path, origin), {
    headers: { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  })
  if (response.status === 401) throw new Error(`${path} 返回 401：平台管理凭证不对，或线上已经轮换过`)
  if (!response.ok) throw Object.assign(new Error(`${path} 返回 HTTP ${response.status}`), { status: response.status })
  return await response.json()
}

// Read-only GETs, written in the one snapshot shape ops/market-dev.mjs loads through
// MARKET_DEV_SNAPSHOT. That loader writes the pre-redesign (006) tables and lets migration 007 carry
// them forward, as a deploy would, so the /api/v1 answers are folded back into that shape. A market
// deployed before the redesign still answers on /api/admin.
const LIFECYCLE = ['visibility', 'state', 'revision', 'versionMode', 'licenseReference', 'reviewedVersion', 'updatedAt', 'access']
async function pullV1() {
  const [list, organizations, keys] = await Promise.all([read('/api/v1/plugins'), read('/api/v1/organizations'), read('/api/v1/keys')])
  // The list is rewritten for the desktop (sources, registries); the detail view is the stored row.
  const plugins = await Promise.all(list.items.map(item => read('/api/v1/plugins/' + encodeURIComponent(item.id))))
  const metadata = plugin => Object.fromEntries(Object.entries(plugin).filter(([key]) => !LIFECYCLE.includes(key)))
  return {
    access: {
      plugins: plugins.map(p => ({ id: p.id, visibility: p.visibility, metadata: metadata(p) })),
      organizations: organizations.items.map(o => ({ id: o.id, name: o.name, enabled: o.enabled ? 1 : 0 })),
      keys: keys.items.map(k => ({ fingerprint: k.fingerprint, label: k.label, enabled: 1, expires_at: null })),
      organizationPolicies: plugins.map(p => ({ plugin_id: p.id })),
      organizationGrants: plugins.flatMap(p => p.access.organizations.map(id => ({ plugin_id: p.id, organization_id: id }))),
      directKeyGrants: plugins.flatMap(p => p.access.keys.map(fingerprint => ({ plugin_id: p.id, fingerprint }))),
    },
    catalog: { items: plugins.map(({ access, ...plugin }) => plugin) },
  }
}
let access, catalog
try { ({ access, catalog } = await pullV1()) }
catch (error) {
  if (error.status !== 404) throw error
  ;[access, catalog] = await Promise.all([read('/api/admin/access'), read('/api/admin/catalog')])
}
await writeFile(OUTPUT, JSON.stringify({ origin: origin.origin, pulledAt: new Date().toISOString(), access, catalog }, null, 2))

const count = (label, rows) => `${label} ${rows?.length ?? 0}`
console.log(`已从 ${origin.origin} 拉取到 ${OUTPUT}`)
console.log([count('插件', access.plugins), count('目录条目', catalog.items), count('组织', access.organizations),
  count('API Key', access.keys), count('组织授权', access.organizationGrants), count('直接授权', access.directKeyGrants)].join(' · '))
console.log('只读快照，不含任何凭据明文；API Key 只有不可逆指纹。包体（.tgz）不在其中。')
console.log(OUTPUT === resolve(root, '../.market-production-snapshot.json')
  ? '本地启动：npm --prefix market/server run dev（会自动加载这份快照；删掉该文件即回到 fixture）'
  : `本地启动：MARKET_DEV_SNAPSHOT=${OUTPUT} npm --prefix market/server run dev`)
