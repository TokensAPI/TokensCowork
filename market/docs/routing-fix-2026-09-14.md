# Shared-scope registry routing fix

> Historical record through 2026-09-14, not current deployment instructions or release acceptance. Local evidence and artifact paths may no longer exist. Commands below are relative to the repository root.

The private installer previously pointed all @tokensapi packages at a single
plugin's /registry/{id}/ endpoint. pnpm's existing-lockfile verification then
requested other installed packages through that endpoint and correctly got 403.

The desktop build overlay now uses /registry/by-package/ for scoped metadata.
The backend resolves the exact package name to exactly one published plugin,
then performs the existing per-plugin access check. Tarball URLs still contain
the original plugin ID and retain their independent authorization checks.
No key gains access to another plugin and no release-age check is disabled.

Regression tests:
`node --test build/modules/market/market-routing-overlay.test.mjs`

Future backend builds should stage with
`node build/modules/market/market-routing-prepare.mjs .build/market-routing-stage`
and use the staged Docker build context. It includes product-components.json
and the package-routing patch, but excludes secrets and database exports.
Do not rebuild a backend that lacks this route after shipping the updated client.

The deployed market backend was patched from its existing image, preserving
unrelated changes and database volumes. The current generated desktop source
and compiled installer have the matching routing change; a running desktop
process loads this module update after restart. A distributable desktop still
requires rebuilding and installing the Windows package.

## Acceptance correction (2026-09-11)

The initial standalone acceptance runner omitted the existing Desktop
`withDesktopPnpmPolicy` wrapper. Its Connect 2.8.0 release-age failure did not
represent the Desktop runner. The acceptance runner now imports that existing
policy directly; no user configuration or new exception was added.

The corrected MarketInstallService acceptance installed and enabled meeting
0.2.0 in the desktop profile at 14:35:51 UTC, preserving all three existing
dependency versions and bundles. This verifies the service path, not an app UI
installation. Evidence lives in the plugin repository's
`test-results/current-profile-install.json`.

## 0.5.0 rebuild (2026-09-14)

Resumed against the current pinned Desktop `63e160ab4387988db894adef766865eab897cf80`
and Harness `fb2c4b9e698e30edb738bca4cf0618587db7d203`, runtime `0.1.5-rc.2`.
The generated installer service includes `/registry/by-package/`.
Routing regression tests passed (2). The installed meeting plugin's Loader
registration/unload and real tool-dispatch tests passed (2) against this runtime.
Windows installer generated and final artifact verification passed. Market tests:
274 passed, 9 skipped; Windows-specific tests: 245 passed; license gate: 561
production packages. Archive inspection confirms version 0.5.0 and shared routing.
The final verifier was corrected to check certificate branding across all runtime
chunks because 0.5.0 dynamically imports certificate setup; required product
branding and forbidden upstream-brand checks are both retained.

Artifact: `.build/desktop/dsh-plugin-desktop/dist/TokensCowork-0.5.0-x64-Setup.exe`
(134399959 bytes, unsigned).
SHA256: `2440375785b85e7ae92b5a4a6b50c7b95e691fd35f2124fc6a15148a7cc2a948`.
This does not establish installed-app UI acceptance or resolve the separate
issues in [the historical regression report](regression-2026-09-11.md). The existing app has not been replaced.
