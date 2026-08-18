import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import verifyPackagedRuntime, {
  type PackagedRuntimeContext,
} from './verify-packaged-runtime.ts'

function codesign(args: readonly string[]): void {
  const result = spawnSync('/usr/bin/codesign', [...args], { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`codesign ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/** Verify the packaged runtime, then apply a recursive ad-hoc signature before DMG creation. */
export default async function afterPack(context: PackagedRuntimeContext): Promise<void> {
  await verifyPackagedRuntime(context)
  if (context.electronPlatformName !== 'darwin') return

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  codesign(['--force', '--deep', '--sign', '-', appPath])
  codesign(['--verify', '--deep', '--strict', '--verbose=4', appPath])
}
