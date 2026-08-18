import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const product = JSON.parse(readFileSync(resolve(root, 'product.json'), 'utf8')).product
const desktopPackagePath = resolve(root, '.build', 'desktop', 'dsh-plugin-desktop', 'package.json')
const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8'))

desktopPackage.version = product.version
desktopPackage.build.appId = product.appId
desktopPackage.build.productName = product.name
desktopPackage.build.nsis.shortcutName = product.name
desktopPackage.build.nsis.artifactName = `${product.name}-\${version}-\${arch}-Setup.\${ext}`

writeFileSync(desktopPackagePath, `${JSON.stringify(desktopPackage, undefined, 2)}\n`)
process.stdout.write(`configure-product: ${product.name} ${product.version} (${product.appId})\n`)
