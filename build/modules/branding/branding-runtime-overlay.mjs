// npm 运行时的显示文案、声明式预设与产品导航策略；只支持当前固定的 DSH 0.2 布局。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { replacePatternOnce } from '../../pipeline/anchors.mjs'

/** 设置中不注册上游 DeepSeek 官方账号页；账号由 TokensAPI 账户页管理。可重复执行。 */
export function hideUpstreamAccountSection(source) {
  const marker = '/* TokensCowork: upstream DeepSeek account settings page hidden. */'
  if (source.includes(marker)) return source
  return replacePatternOnce(source,
    /if \(snapshot\.view\?\.status === "credential-stored"\)( unregister \?\?= ctx\.slots\.register\(\{\s*name: "settings\.section",\s*id: "account",)/u,
    `if (false ${marker})$1`,
    'account settings section')
}

/** 侧栏“更多”菜单去掉上游官方的意见反馈入口；设置与账号项保持不变。可重复执行。 */
export function hideUpstreamFeedbackEntry(source) {
  const marker = '/* TokensCowork: upstream feedback entry hidden. */'
  if (source.includes(marker)) {
    if (source.includes('label: t("contactUs")')) throw new Error('incomplete upstream feedback entry removal')
    return source
  }
  return replacePatternOnce(source,
    /\{\s*id: "contact",\s*label: t\("contactUs"\),\s*icon: [^\n]*\n\s*\},/u,
    marker,
    'account menu feedback entry')
}

/** 隐藏上游云服务侧栏入口，保留连接配置、设置与后台服务。 */
export function hideUpstreamCloudEntry(source) {
  const marker = '// TokensCowork: upstream Agents Anywhere sidebar entry hidden.'
  const registration = /ctx\.effect\(\(\) => services\.slots\.inject\("sidebar\.footer\.action", \(\) => services\.slots\.register\(\{\s*name: "sidebar\.footer\.action",\s*id: "agents-anywhere-next",\s*order: 26,\s*locale: LOCALE_NS,\s*label: \(\) => t\("远程控制"\),\s*inject: \(\) => \(\{ host \}\)\s*\}, ConnectionEntry\)\), "agentsAnywhereOnboarding\.sidebar"\);/g
  const matches = [...source.matchAll(registration)]
  if (source.includes(marker)) {
    if (matches.length || source.includes('"agents-anywhere-next"')) {
      throw new Error('configure-product: incomplete Agents Anywhere entry removal')
    }
    return source
  }
  if (matches.length !== 1 || source.split('"agents-anywhere-next"').length !== 2) {
    throw new Error('configure-product: Agents Anywhere sidebar registration changed; review upstream')
  }
  return source.replace(registration, marker)
}

/**
 * 只读规划 npm 文案和导航覆盖。运行时标题、动态提示词及预设不从
 * Harness 源码编译，必须在依赖安装后处理；任何锚点失配均中断整轮写入。
 */
function planInstalledRuntimeBranding({ stage, productName }) {
  const desktopModules = resolve(stage, 'dsh-plugin-desktop', 'node_modules')
  const writes = new Map()

  const cloudClientPath = resolve(desktopModules, '@agents-anywhere', 'dsh-bridge-next', 'lib', 'client.js')
  const cloudClient = readFileSync(cloudClientPath, 'utf8')
  const hiddenCloudClient = hideUpstreamCloudEntry(cloudClient)
  if (hiddenCloudClient !== cloudClient) writes.set(cloudClientPath, hiddenCloudClient)

  const replaceOnce = (path, replacements) => {
    let content = readFileSync(path, 'utf8')
    let changed = false
    for (const [from, to, expected] of replacements) {
      const count = content.split(from).length - 1
      if (count === expected) {
        content = content.replaceAll(from, to)
        changed = true
        continue
      }
      // node_modules 跨装配保留（见 build/pipeline/staging-prepare.mjs），本函数因此会撞上
      // 自己上一轮改过的文件：锚点已经不在，但替换结果按预期次数在位。那是已生效，
      // 不是上游漂移——上游真变了的话两者都对不上，仍旧抛错。
      if (count === 0 && content.split(to).length - 1 === expected) continue
      throw new Error(
        `configure-product: 品牌锚点 "${from.slice(0, 48)}..." 在 ${path} 出现 ${count} 次,预期 ${expected} 次`,
      )
    }
    if (changed) writes.set(path, content)
  }

  replaceOnce(resolve(desktopModules, '@deepseek-ai', 'dsh-client-ui-directory-picker-browse', 'lib', 'client.js'), [
    ['DSH Desktop native directory picker is unavailable', `${productName} native directory picker is unavailable`, 1],
    ['DSH Desktop directory validation is unavailable', `${productName} directory validation is unavailable`, 1],
  ])

  // Published clients have already substituted DSH_CLIENT_TITLE at compile time.
  // Setting a build environment variable in this outer project cannot change them.
  replaceOnce(resolve(desktopModules, '@deepseek-ai', 'dsh-client-ui-layout', 'lib', 'client.js'), [
    ['const productTitle = "DeepSeek Harness";', `const productTitle = ${JSON.stringify(productName)};`, 1],
  ])
  const htmlTitle = productName.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  replaceOnce(resolve(desktopModules, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'), [
    ['<title>DeepSeek Harness</title>', `<title>${htmlTitle}</title>`, 1],
  ])

  // 1) app-boot 的源码检出说明行（"The DeepSeek Harness implementation checkout is at…"）
  //    在 DSH 0.2.1 整句删除，app-boot 已无上游品牌字样，该项退役。

  // 2) web-app:GUI 说明行("DeepSeek Harness Web GUI"；0.2.0 两处，0.2.1 起只剩一处)。
  replaceOnce(resolve(desktopModules, '@deepseek-ai', 'dsh-web-app', 'lib', 'index.js'), [
    ['DeepSeek Harness Web GUI', `${productName} Web GUI`, 1],
  ])

  // 3) agent 预设 persona：0.2 由 web-app 提供声明式预设补丁。
  const generalPersona = `You are a versatile AI assistant inside ${productName}, powered by the {{model}} model. You handle coding, research, writing, and everyday tasks alike.`
  const webAppRoot = resolve(desktopModules, '@deepseek-ai', 'dsh-web-app')
  for (const preset of ['standard', 'ptc', 'cordis']) {
    replaceOnce(resolve(webAppRoot, 'presets', `${preset}.patch.yml`), [
      ['You are a coding agent powered by the {{model}} model.', generalPersona, 1],
    ])
  }
  replaceOnce(resolve(webAppRoot, 'cordis.patch.yml'), [
    ['You are a coding agent powered by the {{model}} model.', generalPersona, 1],
  ])
  return writes
}

/** 全部 npm 文案契约通过后统一写回，重复执行不会重写已加工文件。 */
export function brandInstalledRuntime(options) {
  for (const [path, content] of planInstalledRuntimeBranding(options)) writeFileSync(path, content)
}

/** 只读验收同一份规则，发现遗漏即失败，不在检查过程中自动修补。 */
export function verifyInstalledRuntimeBranding(options) {
  const missing = [...planInstalledRuntimeBranding(options).keys()]
  if (missing.length) throw new Error(`branding: runtime branding is missing in ${missing.join(', ')}`)
}
