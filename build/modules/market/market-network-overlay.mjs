/* ====================================================================
 * 慢网络容忍
 * 插件包下载走市场代理，整包要在 pnpm 一次请求里传完。pnpm 默认预算
 * 60 秒，8.7 MB 的插件因此需要约 145 KB/s 才装得上；慢链路上三次重试
 * 全部超时，用户只看到“包管理器未成功完成”。
 *
 * Desktop v2.0.18 起 pnpm 由官方插件管理器调用，argv 不再经过市场，
 * 所以下载预算改走 market.registry 建立的那份临时 `.npmrc`（一次操作
 * 写一次、用完删掉，不持久化改写 Profile 的包管理器配置）。超时也不再
 * 靠匹配输出：官方管理器自己把失败归类成 `timeout`，直接用它。
 *
 * 本覆盖只做三件事：加一行下载预算、把超时归成独立失败码、把这个码
 * 翻译成一句用户能看懂的网络提示；详细输出照旧保留。
 * 必须排在 market.registry 之后，它插的那行依赖 registry 建的写入器。
 * ==================================================================== */
import { AnchorError, countOf, replaceOnce } from '../../pipeline/anchors.mjs'

/** 单次请求的下载预算：8.7 MB 的插件在约 15 KB/s 的链路上仍能装完。 */
export const PNPM_FETCH_TIMEOUT_MS = 600000

/** 市场主机侧：放宽下载预算，并把超时归成独立的失败码。 */
function tolerateSlowDownloadsInHost(service) {
  service = replaceOnce(service, "  | 'operation-failed'\n  | 'persistence-failed'",
    "  | 'operation-failed'\n  | 'operation-timeout'\n  | 'persistence-failed'", 'install error codes')
  service = replaceOnce(service, '    /* product npmrc lines */',
    `    // Product policy: one package download gets a budget long enough for a
    // slow link instead of pnpm's 60-second default, which fails any archive
    // whose transfer runs longer. Retries stay at the pnpm default: each
    // attempt already has ten times the budget, so raising the count only
    // multiplies the wait before the user learns the download failed.
    lines.push(\`fetch-timeout=\${PNPM_FETCH_TIMEOUT_MS}\`)`, 'package manager download policy')
  service = replaceOnce(service, "const PRODUCT_NPMRC_FILENAME = '.npmrc'",
    `/** One package download's budget, in milliseconds; see productNpmrcLines. */
const PNPM_FETCH_TIMEOUT_MS = ${PNPM_FETCH_TIMEOUT_MS}
const PRODUCT_NPMRC_FILENAME = '.npmrc'`, 'package manager download budget')
  service = replaceOnce(service, '  private packageManagerError(message: string, details: string): MarketInstallError {',
    `/**
   * Product policy: a download that ran out of time is the one package-manager
   * failure the user can act on, so it carries its own code and its own copy;
   * every other failure keeps the official manager's message. The detailed
   * output is unchanged either way.
   */
  private downloadTimeoutError(details: string): MarketInstallError {
    const message = 'The plugin package download timed out.'
    try { this.logFailure?.(\`dsh-community-market: \${message}\${details === '' ? '' : \`\\n\${details}\`}\`) } catch {}
    return new MarketInstallError('operation-timeout', message, ...(details === '' ? [] : [details]))
  }

  private packageManagerError(message: string, details: string): MarketInstallError {`, 'package manager failure code')
  // 官方管理器把超时与自己终止的运行都标出来，不用再猜 pnpm 的输出。
  return replaceOnce(service, '        throw this.packageManagerError(managementMessage(result.error) ?? fallback, details)',
    `        if (result.packageResult?.kind === 'timeout' || result.packageResult?.timedOut === true) {
          throw this.downloadTimeoutError(details)
        }
        throw this.packageManagerError(managementMessage(result.error) ?? fallback, details)`, 'package manager timeout classification')
}

/** 失败码要有自己的状态码，客户端才能按码给文案，而不是解析英文消息。 */
function reportTimeoutStatus(routes) {
  return replaceOnce(routes, "            : cause.code === 'operation-failed' ? 502\n              : 500",
    "            : cause.code === 'operation-failed' ? 502\n"
    + "              : cause.code === 'operation-timeout' ? 504\n"
    + '                : 500', 'install error status')
}

/** 客户端：超时用产品文案，其余失败仍显示主机消息；详细输出不变。 */
function explainTimeoutToUser(settingsTab) {
  const call = 'operationErrorMessage(cause, '
  const calls = countOf(settingsTab, call)
  if (calls !== 3) throw new AnchorError(`install failure copy：锚点应出现 3 次，实际 ${calls} 次：${call}`)
  settingsTab = settingsTab.replaceAll(call, 'operationErrorMessage(cause, t, ')
  return replaceOnce(settingsTab, `function operationErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : fallback
}`, `function isDownloadTimeout(cause: unknown): boolean {
  return cause !== null
    && typeof cause === 'object'
    && 'code' in cause
    && (cause as { readonly code?: unknown }).code === 'operation-timeout'
}

function operationErrorMessage(
  cause: unknown,
  t: MarketSettingsTabProps['t'],
  fallback: string,
): string {
  // A download that ran out of time is the one failure the user can act on,
  // so it gets product copy; the detailed output below it is unchanged.
  if (isDownloadTimeout(cause)) return t('operationTimeout')
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : fallback
}`, 'install failure copy')
}

const MESSAGES = {
  zh: { operationTimeout: '下载安装包超时，请检查网络后重试。' },
  en: { operationTimeout: 'Downloading the plugin package timed out. Check your network and try again.' },
}

export function tolerateSlowDownloads(input) {
  let { service, routes, settingsTab, locales } = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value.replaceAll('\r\n', '\n')]),
  )
  service = tolerateSlowDownloadsInHost(service)
  routes = reportTimeoutStatus(routes)
  settingsTab = explainTimeoutToUser(settingsTab)
  for (const [language, entries] of Object.entries(MESSAGES)) {
    const anchor = language === 'zh' ? "  tab: '插件市场'," : "  tab: 'Plugin Market',"
    locales = replaceOnce(locales, anchor,
      anchor + '\n' + Object.entries(entries).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`).join('\n'),
      'market locale timeout copy')
  }
  return { service, routes, settingsTab, locales }
}
