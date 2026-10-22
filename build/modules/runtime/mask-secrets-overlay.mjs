/* ============================================================
 * 产品覆盖：宿主日志保留短错误码
 * ============================================================
 * 上游 mask-secrets.ts 把字段名 `code` 当作凭据（本意是 OAuth 授权码），
 * 于是宿主与插件写进日志的每个错误对象 `"code":"…"` 都变成 `****`——
 * 排查 telegram `polling stopped` 与连接中心 `HarnessRpcError` 时只剩
 * 参考号可用（2026-10-22 微信 INTERNAL_UNKNOWN 一案）。产品改成按值判断：
 * `code` 的值长度 ≥ 20、含数字且大小写混合（OAuth 授权码的形状）才脱敏，`internal`、
 * `ECONNRESET`、`session-not-found` 这类短标识原样保留；显式写成
 * auth_code / authorization_code 的字段仍一律脱敏，URL 查询串里的 code
 * 也不变。每个锚点自带守护：上游改动导致锚点失配时装配立即失败。
 * ============================================================ */

const CODE_VALUE_MIN_LENGTH = 20

function replaceOnce(source, anchor, replacement, label) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`prepare-desktop: 未找到唯一锚点（${label}），请复查日志脱敏覆盖`)
  }
  return source.replace(anchor, replacement)
}

/** 把 `code` 从一律脱敏的字段名里拿出来，按值长度单独处理。 */
export function keepShortErrorCodes(source) {
  const marker = '// TokensCowork: keep short error codes readable'
  if (source.includes(marker)) return source
  let patched = replaceOnce(source,
    'client[_-]?secret|code|credential|',
    'client[_-]?secret|auth(?:orization)?[_-]?code|credential|',
    'SECRET_FIELD_NAME 里的 code')
  patched = replaceOnce(patched,
    `const NAMED_SECRET = new RegExp(`,
    `${marker}
// \`code\` 既是 OAuth 授权码的字段名，也是每个错误对象的标识字段。只有值达到
// 授权码的形状（≥ 20 字符、含数字且大小写混合）才脱敏，错误码（internal、ECONNRESET、
// session-not-found、gateway/invocation-unavailable、HTTP_429_RATE_LIMITED）保留。
const QUOTED_LONG_CODE = new RegExp(
  String.raw\`(["'])(code)\\1(\\s*:\\s*)(["'])(?=(?:\\\\.|(?!\\4)[^\\\\])*\\d)(?=(?:\\\\.|(?!\\4)[^\\\\])*[a-z])(?=(?:\\\\.|(?!\\4)[^\\\\])*[A-Z])(?:\\\\.|(?!\\4)[^\\\\]){${CODE_VALUE_MIN_LENGTH},}\\4\`,
  'gu', // 大小写敏感：大小写混合是授权码与 ALL_CAPS 错误码的区分点
)
const NAMED_LONG_CODE = new RegExp(
  String.raw\`\\b(code)\\b(\\s*[:=]\\s*)(?!(?:Bearer|Basic)\\b)(?=[^\\s,;&]*\\d)(?=[^\\s,;&]*[a-z])(?=[^\\s,;&]*[A-Z])[^\\s,;&]{${CODE_VALUE_MIN_LENGTH},}\`,
  'gu',
)
const NAMED_SECRET = new RegExp(`,
    'NAMED_SECRET 定义')
  patched = replaceOnce(patched,
    `    .replace(QUOTED_NAMED_SECRET, (_match, keyQuote: string, name: string, separator: string, valueQuote: string) =>
      \`\${keyQuote}\${name}\${keyQuote}\${separator}\${valueQuote}\${MASK}\${valueQuote}\`)
`,
    `    .replace(QUOTED_NAMED_SECRET, (_match, keyQuote: string, name: string, separator: string, valueQuote: string) =>
      \`\${keyQuote}\${name}\${keyQuote}\${separator}\${valueQuote}\${MASK}\${valueQuote}\`)
    .replace(QUOTED_LONG_CODE, (_match, keyQuote: string, name: string, separator: string, valueQuote: string) =>
      \`\${keyQuote}\${name}\${keyQuote}\${separator}\${valueQuote}\${MASK}\${valueQuote}\`)
`,
    'QUOTED_NAMED_SECRET 替换')
  patched = replaceOnce(patched,
    `    .replace(NAMED_SECRET, (_match, name: string, separator: string) => \`\${name}\${separator}\${MASK}\`)
`,
    `    .replace(NAMED_SECRET, (_match, name: string, separator: string) => \`\${name}\${separator}\${MASK}\`)
    .replace(NAMED_LONG_CODE, (_match, name: string, separator: string) => \`\${name}\${separator}\${MASK}\`)
`,
    'NAMED_SECRET 替换')
  return patched
}

/** 上游用例把短 code 当作必须脱敏的样例；改成产品口径：短码保留、长码仍脱敏。 */
export function alignDiagnosticsSpec(spec) {
  const marker = '// TokensCowork: short error codes stay readable'
  if (spec.includes(marker)) return spec
  let patched = replaceOnce(spec,
    `      code: 'short-code',
`,
    `      code: 'short-code',
      authorization_code: 'oauth-code-4/0AX4XfWhLongEnough',
`,
    'diagnostics.spec code 样例')
  patched = replaceOnce(patched,
    `'{"api_key":"****","code":"****","nested":`,
    `'{"api_key":"****","code":"short-code","authorization_code":"****","nested":`,
    'diagnostics.spec 期望串')
  patched = replaceOnce(patched,
    `    expect(masked).not.toContain('short-code')
`,
    `    ${marker}
    expect(masked).toContain('"code":"short-code"')
    expect(masked).not.toContain('oauth-code-4/0AX4XfWhLongEnough')
    expect(maskSecrets('{"code":"4/0AX4XfWhLongEnoughToBeAnOAuthCode"}')).toBe('{"code":"****"}')
    expect(maskSecrets('HarnessRpcError code: internal')).toBe('HarnessRpcError code: internal')
    expect(maskSecrets('code=4/0AX4XfWhLongEnoughToBeAnOAuthCode')).toBe('code=****')
`,
    'diagnostics.spec 断言')
  return patched
}
