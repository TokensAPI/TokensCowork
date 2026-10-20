/* ====================================================================
 * 慢网络容忍
 * 插件包下载走市场代理，整包要在 pnpm 一次请求里传完。pnpm 默认预算
 * 60 秒，8.7 MB 的插件因此需要约 145 KB/s 才装得上；慢链路上三次重试
 * 全部超时，用户只看到“包管理器未成功完成”。
 * 这里只做两件事：把单次下载预算放宽成进程内参数（与上游的
 * minimumReleaseAge 策略同一位置，不改写 Profile 自己的 pnpm 配置），
 * 并把超时失败翻译成一句用户能看懂的网络提示，详细输出照旧保留。
 * ==================================================================== */
import { AnchorError, countOf, replaceOnce } from '../../pipeline/anchors.mjs'

/** 单次请求的下载预算：8.7 MB 的插件在约 15 KB/s 的链路上仍能装完。 */
export const PNPM_FETCH_TIMEOUT_MS = 600000

/** 市场主机侧：放宽下载预算，并把超时归成独立的失败码。 */
function tolerateSlowDownloadsInHost(service) {
  service = replaceOnce(service, "  | 'operation-failed'\n  | 'persistence-failed'",
    "  | 'operation-failed'\n  | 'operation-timeout'\n  | 'persistence-failed'", 'install error codes')
  service = replaceOnce(service, 'function packageManagerDetails(\n  args: readonly string[],',
    `/**
 * Product policy: one package download gets a budget long enough for a slow
 * link instead of pnpm's 60-second default, which fails any archive whose
 * transfer runs longer. Keep it process-local, like the Desktop
 * minimumReleaseAge argument: the Profile's own pnpm configuration is never
 * rewritten. Retries stay at the pnpm default: each attempt already has ten
 * times the budget, so raising the count only multiplies the wait before the
 * user learns the download failed.
 */
const PNPM_FETCH_TIMEOUT_MS = ${PNPM_FETCH_TIMEOUT_MS}

function slowNetworkPnpmArgs(args: readonly string[]): readonly string[] {
  return [\`--config.fetchTimeout=\${PNPM_FETCH_TIMEOUT_MS}\`, ...args]
}

/**
 * pnpm reports a download that ran out of time through its retry log
 * (\`error (23)\`), the abort message, or the underlying socket error. Matching
 * the output is the only signal available: the package manager exits with the
 * same status for every failure.
 */
const PNPM_DOWNLOAD_TIMEOUT = /TimeoutError|aborted due to timeout|error \\(23\\)|ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT/u

function downloadTimedOut(output: string): boolean {
  return PNPM_DOWNLOAD_TIMEOUT.test(output)
}

function packageManagerDetails(
  args: readonly string[],`, 'package manager download policy')
  service = replaceOnce(service,
    '  private async runPnpm(args: readonly string[], signal: AbortSignal): Promise<void> {\n',
    '  private async runPnpm(requested: readonly string[], signal: AbortSignal): Promise<void> {\n'
    + '    // The reported argv is the argv that ran, tolerance arguments included.\n'
    + '    const args = slowNetworkPnpmArgs(requested)\n', 'package manager invocation')
  return replaceOnce(service, "    return new MarketInstallError('operation-failed', message, details)",
    `    return downloadTimedOut(details)
      ? new MarketInstallError('operation-timeout', 'The plugin package download timed out.', details)
      : new MarketInstallError('operation-failed', message, details)`, 'package manager failure code')
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
  if (calls !== 2) throw new AnchorError(`install failure copy：锚点应出现 2 次，实际 ${calls} 次：${call}`)
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
