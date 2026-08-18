# Repository instructions

This repository is a build-only superproject. Treat `desktop/`, `desktop/deepseek-harness/`, and every directory under `plugins/` as read-only Git submodules. Product changes belong in `product.json`, `build/`, `.github/workflows/`, or top-level documentation.

Never patch a submodule working tree during a product build. Assemble changes only in `.build/desktop/`, which is generated and ignored. Pin every source input by Git commit and initialize submodules recursively in CI.

Do not enable a plugin for redistribution until its complete production dependency license graph passes the Desktop license gate. Never commit credentials, signing certificates, API keys, or generated installer output.
