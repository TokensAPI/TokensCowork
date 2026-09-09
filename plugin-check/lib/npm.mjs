/* npm 子进程调用:统一 --ignore-scripts,被检代码没有机会在检查器
 * 进程里执行安装钩子。 */
import { spawnSync } from 'node:child_process'

export function runNpm(args, cwd, timeout) {
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  })
}
