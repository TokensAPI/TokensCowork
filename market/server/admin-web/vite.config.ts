/**
 * The new console, served at /admin/next/. The build lands in ../admin/next/ (not committed; the
 * Docker image builds it), every file under assets/ is named by its content hash, and nothing is
 * inlined: the console's CSP allows only same-origin scripts and styles (script-src 'self';
 * style-src 'self'), so no inline <script>, no inline <style> and no module-preload polyfill.
 *
 * `npm run dev` proxies the API and the shared console files (Tabler, brand.css, the logo) to the
 * local QA server, ops/market-dev.mjs (MARKET_DEV_ORIGIN, default http://127.0.0.1:8788).
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import type { ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'

const backend = process.env.MARKET_DEV_ORIGIN || 'http://127.0.0.1:8788'
// The market only accepts cookie writes from its own origin; the dev proxy speaks for it.
const proxy: ProxyOptions = {
  target: backend,
  changeOrigin: true,
  configure: (server) => {
    server.on('proxyReq', (request) => request.setHeader('origin', backend))
  },
}

export default defineConfig({
  base: '/admin/next/',
  // /admin/assets/... in a template is the shared console files at run time, not a module to bundle.
  plugins: [vue({ template: { transformAssetUrls: { includeAbsolute: false } } })],
  build: {
    outDir: fileURLToPath(new URL('../admin/next', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
    // Everything is a file of its own: an inlined data: script or style would be refused by the CSP.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The pure modules shared with the docs center live beside the console, in ../admin/assets.
    fs: { allow: ['..'] },
    proxy: { '/api': proxy, '/admin/assets': proxy },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
  },
})
