// Boots Swagger UI. Lives in its own file because the /admin/* CSP is script-src 'self' with no
// 'unsafe-inline', so an inline <script> in api-docs.html would never run.
//
// Calls ride the console session this page shares an origin with, so whoever signed in to the
// console (platform or organization administrator) tries the API as themselves. A token pasted
// into Authorize is sent as a Bearer header, which the server honours before any cookie.
const ui = SwaggerUIBundle({
  url: '/admin/assets/openapi.json',
  dom_id: '#swagger',
  deepLinking: true,
  docExpansion: 'list',
  defaultModelsExpandDepth: 0,
  tryItOutEnabled: true,
  // The admin token must never be written to localStorage: this page is served
  // from the public asset allowlist, so anyone reaching the console origin could read it.
  persistAuthorization: false,
  // Swagger UI otherwise hands the document URL to validator.swagger.io to draw a badge.
  // This page must not talk to anything but this origin.
  validatorUrl: null,
  // It has to wait for the document: before the security schemes load, preauthorizing is a no-op.
  onComplete() {
    identify().catch(() => {})
  },
})

// Says whose rights "Try it out" runs with, from the same session the calls carry. Without a
// session, the local QA server (ops/market-dev.mjs) hands out its throwaway login so "Try it out"
// works with no setup; the worker has no such route, so in production that 404s and nothing
// happens. A signed-in session is never overridden by it.
async function identify() {
  const response = await fetch('/api/v1/session', { cache: 'no-store' })
  const session = response.ok ? await response.json() : null
  let text
  if (session?.authenticated) {
    text = session.role === 'platform'
      ? '当前以平台管理员身份调用（沿用后台登录），可调全部接口。'
      : `当前以组织管理员身份调用（沿用后台登录）：${session.organizationName || '组织'} (#${session.organizationId})，只能调用本组织的接口，其余返回 403。`
    text += '在「Authorize」里填了口令时改用口令。'
  } else {
    const dev = await fetch('/__dev/docs-credential', { cache: 'no-store' }).catch(() => null)
    const token = dev?.ok ? await dev.text() : ''
    if (token) ui.preauthorizeApiKey('adminToken', token)
    text = token
      ? '本地开发实例：已自动填好后台口令，以平台管理员身份调用。'
      : '当前未登录后台：点「Authorize」粘后台口令，或先回后台登录（口令或 TokensAPI 账号均可），再刷新本页。'
  }
  document.getElementById('docs-identity').textContent = text
}
