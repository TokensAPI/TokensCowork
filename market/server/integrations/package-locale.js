// dsh plugin display metadata: `locale/<lang>.json` → `meta.title` / `meta.description`.
// It only ships inside the package tarball, so the archive is streamed and every other file is skipped unread.
import { packageFiles } from './package-files.js'

const localeFile = /^[^/]+\/locale\/([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.json$/iu

// dsh discovers these files through the `./locale/*.json` export; packages without it have no dsh metadata.
export function declaresLocaleFiles(manifest) {
  const exports = manifest?.exports
  return !!exports && typeof exports === 'object' && !Array.isArray(exports)
    && Object.keys(exports).some(key => key === './locale/*.json' || /^\.\/locale\/[^/]+\.json$/u.test(key))
}
export async function packageLocaleMetadata(tgz) {
  const title = {}, description = {}
  for (const [language, source] of await packageFiles(tgz, path => localeFile.exec(path)?.[1])) {
    let meta
    try { meta = JSON.parse(source)?.meta } catch { continue }
    if (!meta || typeof meta !== 'object') continue
    if (typeof meta.title === 'string') title[language] = meta.title
    if (typeof meta.description === 'string') description[language] = meta.description
  }
  return { title, description }
}
