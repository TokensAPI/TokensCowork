// Boots Swagger UI. Lives in its own file because the /admin/* CSP is script-src 'self' with no
// 'unsafe-inline', so an inline <script> in api-docs.html would never run.
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
  // The page shares an origin with the console, so the browser would attach the console session
  // cookie to every call. Calls go out the way a server caller sends them, Bearer only, so what
  // works here works from TokensAPI too, and nothing runs on the console session by accident.
  requestInterceptor(request) {
    request.credentials = 'omit'
    return request
  },
  // The local QA server (ops/market-dev.mjs) exposes its throwaway login here so "Try it out" works
  // with no setup. The worker has no such route, so in production this 404s and nothing happens.
  // It has to wait for the document: before the security schemes load, preauthorizing is a no-op.
  onComplete() {
    fetch('/__dev/docs-credential', { cache: 'no-store' })
      .then(response => (response.ok ? response.text() : ''))
      .then(token => { if (token) ui.preauthorizeApiKey('serviceToken', token) })
      .catch(() => {})
  },
})
