/* ====================================================================
 * 打包产物的应用树读取
 * Electron Builder 可以把应用塞进 app.asar，也可以按目录原样铺开
 * （上游 2.0.17 起 build.asar = false）。两种布局下的文件清单与读取
 * 方式不同，这里统一成一个接口，校验脚本不必关心用的是哪一种。
 * ==================================================================== */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/**
 * 打开 win-unpacked/<Contents> 下 resources 目录中的应用树。
 * @param resources - 打包产物中的 resources 目录。
 * @param loadAsar - 返回 @electron/asar 的函数；仅 asar 布局会调用。
 * @returns layout 为 'asar' 或 'directory'；files 是相对应用根的 POSIX 路径，
 *   read(path) 读取文本，nativeRoot 是校验原生文件是否落盘的根目录。
 */
export function openPackagedTree(resources, loadAsar) {
  const archive = resolve(resources, 'app.asar')
  if (existsSync(archive)) {
    const { extractFile, listPackage } = loadAsar()
    return {
      layout: 'asar',
      files: listPackage(archive).map(path => path.replaceAll('\\', '/').replace(/^\/+/u, '')),
      read: path => extractFile(archive, path.replaceAll('/', sep)).toString('utf8'),
      // asar 布局下原生文件被解包到同级目录，必须按解包根判断是否真的落了盘。
      nativeRoot: resolve(resources, 'app.asar.unpacked'),
    }
  }
  const application = resolve(resources, 'app')
  if (!existsSync(application)) {
    throw new Error(`packaged application tree not found: ${archive} / ${application}`)
  }
  return {
    layout: 'directory',
    // 用 Dirent 判断类型：目录不进清单，坏掉的符号链接也不会让校验崩在 stat 上。
    files: readdirSync(application, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => relative(application, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/')),
    read: path => readFileSync(resolve(application, path), 'utf8'),
    nativeRoot: application,
  }
}
