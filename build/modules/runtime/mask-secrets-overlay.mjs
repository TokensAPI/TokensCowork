/* ============================================================
 * 产品覆盖：宿主日志不再把 `code` 当密钥
 * ============================================================
 * 上游 mask-secrets.ts 把字段名 `code` 当作凭据（本意是 OAuth 授权码），
 * 于是宿主与插件写进日志的每个错误对象 `"code":"…"` 都变成 `****`——
 * 排查 telegram `polling stopped` 与连接中心 `HarnessRpcError` 时只剩
 * 参考号可用（2026-10-22 微信 INTERNAL_UNKNOWN 一案）。用户决定：`code`
 * 一律不按字段名脱敏（按值猜形状的规则以后会漂），显式写成
 * auth_code / authorization_code 的字段仍脱敏，URL 查询串里的 code 与
 * 长 token 形状的通用规则不变。每个锚点自带守护：上游改动导致锚点失配
 * 时装配立即失败。
 * ============================================================ */

function replaceOnce(source, anchor, replacement, label) {
  if (source.split(anchor).length !== 2) {
    throw new Error(`prepare-desktop: 未找到唯一锚点（${label}），请复查日志脱敏覆盖`)
  }
  return source.replace(anchor, replacement)
}

/** 把 `code` 从一律脱敏的字段名里拿出来；auth_code / authorization_code 仍脱敏。 */
export function keepErrorCodesReadable(source) {
  const marker = 'auth(?:orization)?[_-]?code'
  if (source.includes(marker)) return source
  return replaceOnce(source,
    'client[_-]?secret|code|credential|',
    `client[_-]?secret|${marker}|credential|`,
    'SECRET_FIELD_NAME 里的 code')
}

/** 上游用例把 code 当作必须脱敏的样例；改成产品口径：code 保留、auth_code 仍脱敏。 */
export function alignDiagnosticsSpec(spec) {
  const marker = '// TokensCowork: error codes stay readable'
  if (spec.includes(marker)) return spec
  let patched = replaceOnce(spec,
    `      code: 'short-code',
`,
    `      code: 'short-code',
      authorization_code: 'oauth-code',
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
    expect(masked).not.toContain('oauth-code')
    expect(maskSecrets('HarnessRpcError code: internal')).toBe('HarnessRpcError code: internal')
    expect(maskSecrets('GET https://example.com/cb?code=abc')).toBe('GET https://example.com/cb?code=****')
`,
    'diagnostics.spec 断言')
  return patched
}
