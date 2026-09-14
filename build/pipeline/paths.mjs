import { resolve } from 'node:path'

/** Keep parallel local validation inside its own generated directory. */
export function productStage(root) {
  const name = process.env.PRODUCT_STAGE_NAME ?? 'desktop'
  if (!/^desktop(?:-[a-zA-Z0-9][a-zA-Z0-9-]*)?$/u.test(name)) {
    throw new Error('PRODUCT_STAGE_NAME must be desktop or desktop-<validation-name>')
  }
  return resolve(root, '.build', name)
}
